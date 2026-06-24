"""Bounded visual QC for Sophia image-forward PPTX slides.

This helper performs one multimodal review of a rendered slide image against
the slide spec. It intentionally does not loop or repair; callers decide
whether to regenerate once or fail the build cleanly.
"""

from __future__ import annotations

import argparse
import base64
import difflib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

try:  # Pillow is present in the builder image-gen runtime; tests monkeypatch when absent.
    from PIL import Image
except Exception:  # pragma: no cover - dependency availability varies.
    Image = None  # type: ignore[assignment]

_DEFAULT_QC_MODEL = "claude-sonnet-4-6"

_REVIEWER_PROMPT = """You are a strict slide QC reviewer. You are shown one rendered presentation slide and the
spec it must satisfy. Reply with JSON only: {"pass": true|false, "reasons": ["..."]}.

The slide has a hard layout contract: top 14% is the title band, bottom 16% is the
visible narrative band, and the middle 70% is the visual safe area. Title/narrative
text must be baked into those bands; visual elements must not collide with them.

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


def _merge_presence(payload: dict[str, Any], presence: dict[str, Any]) -> dict[str, Any]:
    merged = dict(payload)
    reasons = [str(reason) for reason in (merged.get("reasons") or []) if isinstance(reason, str)]
    presence_reasons = [
        str(reason)
        for reason in (presence.get("presence_reasons") or [])
        if isinstance(reason, str)
    ]
    if presence_reasons:
        reasons.extend(presence_reasons)
    merged["reasons"] = reasons[:5]
    for key in (
        "title_present",
        "caption_present",
        "presence_pass",
        "presence_reasons",
        "presence_skipped",
        "presence_unavailable",
    ):
        if key in presence:
            merged[key] = presence[key]
    return merged


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


def _ocr_unavailable_reason() -> str | None:
    if Image is None:
        return "deterministic presence OCR skipped: Pillow is not installed"
    if not shutil.which("tesseract"):
        return "deterministic presence OCR skipped: tesseract is not installed"
    return None


def _ocr_crop_text(image_file: Path, *, y0: float, y1: float) -> str:
    if Image is None:
        return ""
    try:
        with Image.open(image_file) as image:
            width, height = image.size
            crop = image.crop((0, int(height * y0), width, int(height * y1)))
            with tempfile.NamedTemporaryFile(suffix=".png") as handle:
                crop.save(handle.name)
                return _ocr_text(Path(handle.name))
    except Exception:
        return ""


_TEXT_READS_RE = re.compile(r"\bTHE\s+TEXT\s+READS\s*:\s*", re.IGNORECASE)
_JSON_FIELD_TITLE_KEYS = ("title", "heading", "title at top", "title band text")
_JSON_FIELD_CAPTION_KEYS = (
    "caption",
    "takeaway",
    "bottom caption band",
    "bottom caption",
    "caption band",
    "caption band text",
    "bottom caption band text",
    "bottom caption text",
    "narrative",
    "narrative band",
    "narrative band text",
    "bottom narrative",
    "bottom narrative band",
    "bottom narrative band text",
    "bottom narrative text",
)


def _clean_expected_text(value: str) -> str:
    value = _TEXT_READS_RE.sub("", value)
    return value.strip().strip("\"'`[]{} ")


def _first_json_string(payload: Any, keys: tuple[str, ...]) -> str | None:
    if isinstance(payload, dict):
        for key, value in payload.items():
            if str(key).strip().lower() in keys and isinstance(value, str) and value.strip():
                return _clean_expected_text(value)
        for value in payload.values():
            found = _first_json_string(value, keys)
            if found:
                return found
    if isinstance(payload, list):
        for item in payload:
            found = _first_json_string(item, keys)
            if found:
                return found
    return None


def _json_string_values(payload: Any) -> list[str]:
    if isinstance(payload, str):
        return [payload]
    if isinstance(payload, dict):
        values: list[str] = []
        for value in payload.values():
            values.extend(_json_string_values(value))
        return values
    if isinstance(payload, list):
        values: list[str] = []
        for item in payload:
            values.extend(_json_string_values(item))
        return values
    return []


def _line_field_value(spec_text: str, keys: tuple[str, ...]) -> str | None:
    key_pattern = "|".join(re.escape(key).replace("\\ ", "\\s+") for key in keys)
    pattern = re.compile(
        rf"^\s*(?:{key_pattern})\s*(?:band)?\s*[:=-]\s*(.+?)\s*$",
        re.IGNORECASE,
    )
    for line in spec_text.splitlines():
        match = pattern.match(line)
        if match:
            return _clean_expected_text(match.group(1))
    return None


def _expected_text(spec_text: str, keys: tuple[str, ...]) -> str | None:
    try:
        loaded = json.loads(spec_text)
    except Exception:
        loaded = None
    if loaded is not None:
        found = _first_json_string(loaded, keys)
        if found:
            return found
        for value in _json_string_values(loaded):
            found = _line_field_value(value, keys)
            if found:
                return found
    return _line_field_value(spec_text, keys)


def _normalize_presence_text(value: str) -> str:
    value = _TEXT_READS_RE.sub("", value).lower()
    return re.sub(r"[^a-z0-9]+", " ", value).strip()


def _expected_text_present(expected: str | None, observed: str) -> bool:
    expected_norm = _normalize_presence_text(expected or "")
    if not expected_norm:
        return True
    observed_norm = _normalize_presence_text(observed)
    if not observed_norm:
        return False
    if expected_norm in observed_norm:
        return True
    ratio = difflib.SequenceMatcher(None, expected_norm, observed_norm).ratio()
    if ratio >= 0.58:
        return True
    expected_tokens = {token for token in expected_norm.split() if len(token) > 2}
    if not expected_tokens:
        return False
    observed_tokens = set(observed_norm.split())
    return len(expected_tokens & observed_tokens) / len(expected_tokens) >= 0.55


def _presence_result(image_file: Path, spec_file: Path) -> dict[str, Any]:
    try:
        spec_text = spec_file.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        spec_text = ""
    expected_title = _expected_text(spec_text, _JSON_FIELD_TITLE_KEYS)
    expected_caption = _expected_text(spec_text, _JSON_FIELD_CAPTION_KEYS)
    if expected_title or expected_caption:
        if reason := _ocr_unavailable_reason():
            return {
                "presence_skipped": True,
                "presence_unavailable": True,
                "presence_reasons": [reason],
            }
    title_text = _ocr_crop_text(image_file, y0=0.0, y1=0.14)
    caption_text = _ocr_crop_text(image_file, y0=0.84, y1=1.0)
    title_present = _expected_text_present(expected_title, title_text)
    caption_present = _expected_text_present(expected_caption, caption_text)
    reasons: list[str] = []
    if expected_title and not title_present:
        reasons.append("Required title text was not detected in the top title band")
    if expected_caption and not caption_present:
        reasons.append("Required narrative text was not detected in the bottom band")
    return {
        "title_present": bool(title_present),
        "caption_present": bool(caption_present),
        "presence_pass": not reasons,
        "presence_reasons": reasons,
    }


_FORBIDDEN_RASTER_TEXT: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bTHE\s+TEXT\s+READS\b", re.IGNORECASE), "THE TEXT READS"),
    (re.compile(r"\bCAPTION\s*:", re.IGNORECASE), "caption:"),
    (re.compile(r"\bPROMPT\s*:", re.IGNORECASE), "prompt:"),
    (re.compile(r"\[\s*VISUAL\s*\]", re.IGNORECASE), "[visual]"),
    (re.compile(r"\bINSTRUCTIONS?\s*:", re.IGNORECASE), "instruction label"),
)


def _raster_layout_reasons(image_file: Path) -> list[str]:
    text = _ocr_text(image_file)
    if not text:
        return []
    reasons: list[str] = []
    for pattern, label in _FORBIDDEN_RASTER_TEXT:
        if pattern.search(text):
            reasons.append(f"Generated bitmap still contains literal prompt scaffolding: {label}")
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
    presence = _presence_result(image_file, spec_file)
    if presence.get("presence_pass") is not True and presence.get("presence_skipped") is not True:
        return _merge_presence(_json_result(False, []), presence)
    if not os.environ.get("ANTHROPIC_API_KEY", "").strip():
        return _merge_presence(
            _qc_unavailable_result("slide QC skipped: ANTHROPIC_API_KEY is not set"),
            presence,
        )
    client, error = _anthropic_client()
    if error:
        return _merge_presence(error, presence)
    content = _review_content(image_file, spec_file, reference_image)

    try:
        response = client.messages.create(
            model=model or os.environ.get("SOPHIA_SLIDE_QC_MODEL", _DEFAULT_QC_MODEL),
            max_tokens=400,
            temperature=0,
            messages=[{"role": "user", "content": content}],
        )
    except Exception as exc:  # noqa: BLE001 - QC fails closed, never loops.
        return _merge_presence(
            _json_result(False, [f"slide QC call failed: {exc.__class__.__name__}"]),
            presence,
        )
    return _merge_presence(_combine_with_raster_checks(parse_review(_extract_text(response)), image_file), presence)


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
