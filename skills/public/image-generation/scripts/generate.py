"""Image generation script for the ``image-generation`` skill.

Backed by OpenAI image models. Wraps two endpoints:

- ``client.images.generate(...)`` with ``gpt-image-2`` for prompts without reference images.
- ``client.images.edit(...)``     with ``gpt-image-2`` for prompts that
  condition on one or more reference images. This is the path
  ``ppt-generation`` uses to keep visual consistency across slides ("use the
  previous slide as a reference for the next slide").

CLI surface is intentionally identical to the previous Gemini-backed
script so ``ppt-generation/scripts/generate.py`` and the upstream SKILL.md
examples keep working without changes.

Failure modes:
- Missing ``OPENAI_API_KEY`` -> exit 2 with message on stderr (NOT a
  silent string return — the prior Gemini script's silent failure was the
  root cause of long builder loops on .pptx tasks).
- API / network error      -> exit 1 with the OpenAI error on stderr.
- Output file not written   -> exit 1 (defensive — the API returned
  success but the bytes never landed on disk).
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import json as _json
import os
import sys
from pathlib import Path
from typing import Any

from PIL import Image

# OpenAI's ``gpt-image-2`` supports a small set of canonical sizes. We map
# the human-friendly aspect-ratio strings used by the SKILL.md examples
# onto the closest supported size. Choices align with the upstream
# Gemini-backed defaults so prompts that worked there keep working here.
_ASPECT_TO_SIZE = {
    "1:1": "1024x1024",
    "16:9": "1536x1024",
    "4:3": "1024x1024",
    "9:16": "1024x1536",
    "2:3": "1024x1536",
    "3:2": "1536x1024",
}
_DEFAULT_SIZE = "1536x1024"
_SLIDE_VISUAL_SIZE = "1536x1024"
_SLIDE_VISUAL_EDIT_SIZE = "1536x1024"
_OPENAI_SUPPORTED_SIZES = {"auto", "1024x1024", "1536x1024", "1024x1536"}
_SLIDE_VISUAL_ASPECT_RATIO = 16 / 9

_GENERATE_MODEL = "gpt-image-2"
_EDIT_MODEL = "gpt-image-2"
_TRUTHY_VALUES = {"1", "true", "yes", "on"}
_TRACE_PROMPT_MAX = 12000
_LANGSMITH_CLIENT: Any | None = None

_SOPHIA_SLIDE_STYLE = (
    "Visual system: a premium presentation slide with a single coherent style chosen "
    "by the prompt. Preserve that named style faithfully across the whole deck. "
    "Use generous white space, clear visual hierarchy, and one confident focal element. "
    "Brand palette: deep ink navy (#1F2A37) for primary text; considered blue (#2E5AAC) "
    "as the lead accent; warm teal (#2A9D8F) and restrained gold (#D4AF37) as secondary "
    "accents; soft coral (#E76F51) sparingly; on light paper (#FFFFFF / #F5F7FA) or a "
    "purposeful dark canvas when the chosen style requires it. Typography must be crisp, "
    "high-contrast, and perfectly legible. Avoid template sameness; vary diagram structure "
    "while keeping the deck's chosen style cohesive. Looks like a slide from a deck that "
    "took real design care."
)

_SOPHIA_SLIDE_AVOID = (
    "Avoid: generic AI gradient meshes and purple/pink glow; glossy or plastic 3D render; "
    "oversaturated stock-photo treatment; clip-art, emoji, or decorative borders; busy, "
    "cluttered, or cramped layouts; tiny or low-contrast text; watermarks or logos; "
    "literal 'AI' clichés (glowing brains, circuit boards, robots, binary)."
)
_SOPHIA_SLIDE_AVOID = (
    _SOPHIA_SLIDE_AVOID
    + " No purple/pink AI-gradient hero. No single-font template look. "
    + "No generic stock-deck styling."
)

_SOPHIA_SLIDE_ZONE_CONTRACT = (
    "Slide zone contract: render the complete final 16:9 slide bitmap with all title and "
    "caption text baked into the image. Reserve the top 14% as a clean title band, the "
    "bottom 11% as a one-line caption/takeaway band, and the center 75% as the visual "
    "safe area. Put the title only in the top band, the caption only in the bottom band, "
    "and keep diagrams, charts, arrows, labels, callouts, and decorative marks out of both "
    "bands. Do not leave title/caption bands blank when the prompt supplies that text."
)

_SOPHIA_IMAGE_STYLE = (
    "Visual style: warm, luminous, human-centred, with a quiet cosmic undertone. Clean "
    "editorial composition, generous negative space, soft natural light, calm presence. "
    "Brand palette: deep ink navy (#1F2A37), considered blue (#2E5AAC), warm teal (#2A9D8F), "
    "restrained gold (#D4AF37), soft coral (#E76F51) on light paper tones. Painterly-but-refined, "
    "premium, understated."
)

_SOPHIA_IMAGE_AVOID = (
    "Avoid: generic AI gradient meshes and purple/pink/blue glow; glossy plastic 3D render; "
    "oversaturated stock-photo lighting; corporate clip-art; busy or cluttered scenes; "
    "any text, letters, numbers, logos, watermarks, or UI elements in the image; "
    "literal 'AI' clichés (glowing brains, circuit boards, robots, binary)."
)

# Cap raw provider detail so a giant HTML error page or megabyte traceback
# can't flood the builder's bash buffer. 2000 chars is plenty to diagnose.
_RAW_ERROR_MAX = 2000


def _extract_raw_error(exc: BaseException) -> str:
    """Best-effort pull of the RAW provider response body / exception text.

    Prod logs only ever showed ``error_class=api_error`` — the actual
    provider message (e.g. an org-verification or content-policy detail)
    was swallowed. This digs through the shapes the OpenAI SDK uses for
    HTTP errors (``response.text``, ``response.json()``, ``.body``) and
    falls back to ``str(exc)``. It must NEVER raise — diagnostics that
    crash are worse than no diagnostics.
    """
    parts: list[str] = []
    try:
        parts.append(f"{type(exc).__name__}: {exc}")
    except Exception:  # noqa: BLE001 - str(exc) on exotic exceptions can fail
        parts.append(type(exc).__name__)
    # OpenAI/httpx APIStatusError carries the raw HTTP response + parsed body.
    for attr in ("body", "code", "status_code"):
        try:
            value = getattr(exc, attr, None)
            if value not in (None, ""):
                parts.append(f"{attr}={value!r}")
        except Exception:  # noqa: BLE001 - attribute access can raise on proxies
            continue
    try:
        response = getattr(exc, "response", None)
        if response is not None:
            text = getattr(response, "text", None)
            if isinstance(text, str) and text.strip():
                parts.append(f"response.text={text.strip()}")
    except Exception:  # noqa: BLE001 - never let capture itself raise
        pass
    detail = " | ".join(p for p in parts if p)
    if len(detail) > _RAW_ERROR_MAX:
        detail = detail[:_RAW_ERROR_MAX] + "...[truncated]"
    return detail


def _fail(reason: str, message: str, *, raw_error: str = "", exit_code: int = 1) -> None:
    """Emit one machine-readable failure line plus a short safe message.

    ``raw_error`` carries the truncated RAW provider detail so failures are
    diagnosable from logs alone instead of just ``reason=api_error``. It is
    surfaced both on the machine-readable line and as its own stderr line.
    """
    line = f"IMAGEGEN_FAIL reason={reason}"
    if raw_error:
        line += f" raw_error={raw_error!r}"
    print(line, file=sys.stderr)
    print(message, file=sys.stderr)
    if raw_error:
        print(f"raw_error: {raw_error}", file=sys.stderr)
    sys.exit(exit_code)


def _classify_exception(exc: BaseException) -> str:
    text = f"{type(exc).__name__}: {exc}".lower()
    if "organization" in text and ("verified" in text or "verify" in text):
        return "org_not_verified"
    if any(token in text for token in ("invalid api key", "incorrect api key", "401", "unauthorized", "authentication")):
        return "auth_invalid"
    if any(token in text for token in ("content policy", "content_policy", "safety", "blocked", "moderation")):
        return "content_blocked"
    if any(token in text for token in ("timeout", "timed out", "readtimeout")):
        return "timeout"
    if any(token in text for token in ("connection", "connecterror", "network", "proxy", "name resolution", "dns")):
        return "egress_blocked"
    if "size" in text and any(token in text for token in ("invalid", "unsupported", "not one of")):
        return "invalid_size"
    return "api_error"


def _env_flag_preferred(*names: str) -> bool:
    for name in names:
        value = os.getenv(name)
        if value is not None and value.strip():
            return value.strip().lower() in _TRUTHY_VALUES
    return False


def _env_value(*names: str) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value and value.strip():
            return value.strip().strip('"').strip("'").strip()
    return None


def _langsmith_tracing_configured() -> bool:
    tracing_requested = _env_flag_preferred("LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2", "LANGCHAIN_TRACING") or (
        os.getenv("SOPHIA_BUILDER_LANGSMITH_TRACING", "").strip().lower() in _TRUTHY_VALUES
    )
    if not tracing_requested:
        return False
    return bool((os.getenv("LANGSMITH_API_KEY") or os.getenv("LANGCHAIN_API_KEY") or "").strip())


def _langsmith_client() -> Any | None:
    global _LANGSMITH_CLIENT
    if not _langsmith_tracing_configured():
        return None
    if _LANGSMITH_CLIENT is not None:
        return _LANGSMITH_CLIENT
    try:
        from langsmith import Client

        _LANGSMITH_CLIENT = Client()
    except Exception:
        return None
    return _LANGSMITH_CLIENT


def _langsmith_project_name() -> str:
    return _env_value("LANGSMITH_PROJECT", "LANGCHAIN_PROJECT") or "Sophia"


def _langsmith_parent_metadata() -> dict[str, str]:
    metadata: dict[str, str] = {}
    for env_name, metadata_key in (
        ("SOPHIA_PARENT_TRACE_ID", "parent_trace_id"),
        ("SOPHIA_PARENT_RUN_ID", "parent_run_id"),
        ("SOPHIA_PARENT_DOTTED_ORDER", "parent_dotted_order"),
        ("SOPHIA_THREAD_ID", "thread_id"),
    ):
        value = _env_value(env_name)
        if value:
            metadata[metadata_key] = value
    return metadata


def _langsmith_parent_for_trace() -> Any | None:
    return _env_value("SOPHIA_PARENT_DOTTED_ORDER", "LANGSMITH_DOTTED_ORDER")


def _truncate_trace_text(value: str, limit: int = _TRACE_PROMPT_MAX) -> tuple[str, bool]:
    if len(value) <= limit:
        return value, False
    return value[:limit] + "...[truncated]", True


def _trace_reference_name(path: str) -> str:
    try:
        return Path(path).name
    except Exception:
        return str(path)


def _image_request_model(valid_refs: list[str]) -> str:
    return _EDIT_MODEL if valid_refs else _GENERATE_MODEL


def _image_trace_inputs(*, prompt: str, valid_refs: list[str], size: str, quality: str | None) -> dict[str, Any]:
    model = _image_request_model(valid_refs)
    traced_prompt, truncated = _truncate_trace_text(prompt)
    return {
        "provider": "openai",
        "model": model,
        "endpoint": "images.edit" if valid_refs else "images.generate",
        "prompt": traced_prompt,
        "prompt_truncated": truncated,
        "reference_image_count": len(valid_refs),
        "reference_images": [_trace_reference_name(path) for path in valid_refs],
        "size": size,
        "quality": quality,
    }


def _image_trace_outputs(response: object, *, model: str) -> dict[str, Any]:
    data = getattr(response, "data", None)
    count = len(data) if isinstance(data, list) else 0
    first = data[0] if count else None
    return {
        "provider": "openai",
        "model": model,
        "response_data_count": count,
        "has_b64_payload": bool(getattr(first, "b64_json", None)),
    }


class _EnabledLangSmithTraceContext:
    def __init__(self, enabled_context: Any, trace_context: Any) -> None:
        self._enabled_context = enabled_context
        self._trace_context = trace_context
        self._stack = contextlib.ExitStack()

    def __enter__(self) -> Any:
        self._stack.enter_context(self._enabled_context)
        return self._stack.enter_context(self._trace_context)

    def __exit__(self, exc_type: object, exc: object, tb: object) -> bool | None:
        return self._stack.__exit__(exc_type, exc, tb)


def _langsmith_trace_context(*, prompt: str, valid_refs: list[str], size: str, quality: str | None) -> Any | None:
    client = _langsmith_client()
    if client is None:
        return None
    model = _image_request_model(valid_refs)
    try:
        from langsmith import trace, tracing_context

        project_name = _langsmith_project_name()
        metadata = {
            "sophia_component": "builder_image_generation",
            **_langsmith_parent_metadata(),
        }
        parent = _langsmith_parent_for_trace()
        enabled_context = tracing_context(
            enabled=True,
            client=client,
            project_name=project_name,
            parent=parent,
            tags=["sophia", "image_generation", "openai"],
            metadata=metadata,
        )
        trace_context = trace(
            "Sophia Image Generation OpenAI Call",
            run_type="tool",
            project_name=project_name,
            inputs=_image_trace_inputs(prompt=prompt, valid_refs=valid_refs, size=size, quality=quality),
            metadata={
                **metadata,
                "ls_provider": "openai",
                "ls_model_name": model,
                "image_endpoint": "edit" if valid_refs else "generate",
            },
            tags=["sophia", "image_generation", "openai"],
            client=client,
            parent=parent,
        )
        return _EnabledLangSmithTraceContext(enabled_context, trace_context)
    except Exception:
        return None


def _flush_langsmith_traces() -> None:
    client = _LANGSMITH_CLIENT
    if client is None:
        return
    try:
        client.flush(timeout=5)
    except Exception:
        pass


def _resolve_size(aspect_ratio: str) -> str:
    return _ASPECT_TO_SIZE.get((aspect_ratio or "").strip(), _DEFAULT_SIZE)


def _resolve_request_size(
    *,
    explicit_size: str | None,
    slide_visual: bool,
    aspect_ratio: str,
    has_references: bool,
) -> str:
    resolved = explicit_size or (_SLIDE_VISUAL_SIZE if slide_visual else _resolve_size(aspect_ratio))
    if resolved not in _OPENAI_SUPPORTED_SIZES:
        return _SLIDE_VISUAL_EDIT_SIZE if slide_visual else _DEFAULT_SIZE
    return resolved


def _prompt_field_text(key: str, value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
    else:
        text = _json.dumps(value, ensure_ascii=False, sort_keys=True)
    if not text or text in {"[]", "{}"}:
        return None
    return f"{key}: {text}"


def _prompt_text_from_payload(payload: object, raw: str, *, slide_visual: bool) -> str:
    if not isinstance(payload, dict):
        return raw.strip()
    prompt = str(payload.get("prompt") or "").strip()
    if slide_visual:
        return prompt or raw.strip()
    fields = [prompt] if prompt else []
    fields.extend(
        text
        for key, value in payload.items()
        if key != "prompt" and (text := _prompt_field_text(str(key), value))
    )
    return "\n".join(fields).strip() or raw.strip()


def _subject_from_prompt_file(prompt_file: str, *, slide_visual: bool) -> str:
    with open(prompt_file, encoding="utf-8") as f:
        raw = f.read()
    try:
        subject = _prompt_text_from_payload(_json.loads(raw), raw, slide_visual=slide_visual)
    except Exception:
        subject = raw.strip()
    return subject


def _build_prompt(prompt_file: str, *, slide_visual: bool) -> str:
    subject = _subject_from_prompt_file(prompt_file, slide_visual=slide_visual)
    if slide_visual:
        return f"{subject}\n\n{_SOPHIA_SLIDE_ZONE_CONTRACT}\n\n{_SOPHIA_SLIDE_STYLE}\n\n{_SOPHIA_SLIDE_AVOID}"
    return f"{subject}\n\n{_SOPHIA_IMAGE_STYLE}\n\n{_SOPHIA_IMAGE_AVOID}"


def _validate_reference_image(image_path: str) -> bool:
    """True iff Pillow can fully load the file as an image."""
    try:
        with Image.open(image_path) as img:
            img.verify()
        with Image.open(image_path) as img:
            img.load()
        return True
    except Exception as e:  # pragma: no cover - exercised manually
        print(f"Warning: reference image '{image_path}' is invalid: {e}", file=sys.stderr)
        return False


def _filter_valid_references(reference_images: list[str]) -> list[str]:
    invalid = [p for p in reference_images if not _validate_reference_image(p)]
    if invalid:
        names = ", ".join(_trace_reference_name(path) for path in invalid)
        _fail(
            "invalid_reference_image",
            f"Reference image validation failed for {len(invalid)} file(s): {names}",
            exit_code=2,
        )
    return list(reference_images)


def _decode_to_file(b64_payload: str, output_file: str) -> None:
    Path(output_file).parent.mkdir(parents=True, exist_ok=True)
    with open(output_file, "wb") as fh:
        fh.write(base64.b64decode(b64_payload))


def _extract_b64(response: object) -> str:
    """Pull the base64 image payload out of an OpenAI Images response.

    The SDK returns a Pydantic-style object; the relevant data lives at
    ``response.data[0].b64_json``. We fall back through a couple of
    field names defensively because the API has been known to switch
    defaults between ``url`` and ``b64_json`` across model versions.
    """
    data = getattr(response, "data", None)
    if not data:
        raise RuntimeError("OpenAI image response had no `data` field")
    item = data[0]
    payload = getattr(item, "b64_json", None)
    if payload:
        return payload
    raise RuntimeError(
        "OpenAI image response did not include base64 payload; ensure response_format='b64_json' is supported by the model"
    )


def _image_request_kwargs(prompt: str, size: str, quality: str | None, *, model: str) -> dict[str, object]:
    kwargs: dict[str, object] = {
        "model": model,
        "prompt": prompt,
        "size": size,
    }
    if quality:
        kwargs["quality"] = quality
    return kwargs


def _call_generate(client: object, *, prompt: str, size: str, quality: str | None) -> object:
    return client.images.generate(**_image_request_kwargs(prompt, size, quality, model=_GENERATE_MODEL))


def _call_edit(
    client: object,
    *,
    prompt: str,
    valid_refs: list[str],
    size: str,
    quality: str | None,
) -> object:
    ref_handles = [open(p, "rb") for p in valid_refs]
    try:
        kwargs = _image_request_kwargs(prompt, size, quality, model=_EDIT_MODEL)
        kwargs["image"] = ref_handles if len(ref_handles) > 1 else ref_handles[0]
        return client.images.edit(**kwargs)
    finally:
        for fh in ref_handles:
            fh.close()


def _call_image_api(
    client: object,
    *,
    prompt: str,
    valid_refs: list[str],
    size: str,
    quality: str | None,
) -> object:
    if valid_refs:
        return _call_edit(client, prompt=prompt, valid_refs=valid_refs, size=size, quality=quality)
    return _call_generate(client, prompt=prompt, size=size, quality=quality)


def _call_image_api_with_trace(
    client: object,
    *,
    prompt: str,
    valid_refs: list[str],
    size: str,
    quality: str | None,
) -> object:
    model = _image_request_model(valid_refs)
    trace_context = _langsmith_trace_context(prompt=prompt, valid_refs=valid_refs, size=size, quality=quality)
    if trace_context is None:
        return _call_image_api(client, prompt=prompt, valid_refs=valid_refs, size=size, quality=quality)
    with trace_context as run:
        response = _call_image_api(client, prompt=prompt, valid_refs=valid_refs, size=size, quality=quality)
        try:
            run.end(outputs=_image_trace_outputs(response, model=model))
        except Exception:
            pass
        return response


def _openai_client_from_env() -> object:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        _fail("missing_api_key", "OPENAI_API_KEY is not set", exit_code=2)
    try:
        from openai import OpenAI  # transitive dep via langchain-openai
    except ImportError as e:  # pragma: no cover - sandbox should always have this
        _fail("api_error", f"openai SDK is not available in the sandbox: {type(e).__name__}", exit_code=2)
    return OpenAI(api_key=api_key)


def _extract_payload_or_fail(response: object) -> str:
    try:
        return _extract_b64(response)
    except Exception as e:
        _fail(
            "empty_output",
            f"OpenAI image response did not include usable image bytes: {type(e).__name__}",
            raw_error=_extract_raw_error(e),
        )


def _call_image_api_or_fail(
    client: object,
    *,
    prompt: str,
    valid_refs: list[str],
    size: str,
    quality: str | None,
) -> object:
    try:
        return _call_image_api_with_trace(
            client,
            prompt=prompt,
            valid_refs=valid_refs,
            size=size,
            quality=quality,
        )
    except Exception as e:
        _fail(
            _classify_exception(e),
            f"OpenAI image generation failed: {type(e).__name__}",
            raw_error=_extract_raw_error(e),
        )


def _emit_generation_request(
    *,
    slide_visual: bool,
    quality: str | None,
    size: str,
    prompt: str,
) -> None:
    print(f"[gen] slide_visual={slide_visual} quality={quality} size={size}")
    print(f"[gen] PROMPT_SENT: {prompt}")


def _emit_generation_result(output_file: str, valid_refs: list[str]) -> None:
    path = Path(output_file)
    ext = path.suffix.lower() or ""
    n_bytes = path.stat().st_size if path.exists() else 0
    print(f"[gen] result: ext={ext} bytes={n_bytes} ref_images={len(valid_refs)}")


def _assert_output_file_written(output_file: str) -> None:
    if not Path(output_file).exists() or Path(output_file).stat().st_size == 0:
        _fail("empty_output", "OpenAI image generation succeeded but no bytes landed on disk")


def _normalize_slide_visual_aspect(output_file: str) -> None:
    try:
        with Image.open(output_file) as img:
            source = img.convert("RGBA")
            width, height = source.size
            if width <= 0 or height <= 0:
                raise ValueError("Image has invalid dimensions")
            current_ratio = width / height
            if abs(current_ratio - _SLIDE_VISUAL_ASPECT_RATIO) < 0.001:
                return
            if current_ratio > _SLIDE_VISUAL_ASPECT_RATIO:
                canvas_width = width
                canvas_height = max(1, round(width / _SLIDE_VISUAL_ASPECT_RATIO))
            else:
                canvas_width = max(1, round(height * _SLIDE_VISUAL_ASPECT_RATIO))
                canvas_height = height
            canvas = Image.new("RGBA", (canvas_width, canvas_height), (255, 255, 255, 255))
            left = max(0, (canvas_width - width) // 2)
            top = max(0, (canvas_height - height) // 2)
            canvas.alpha_composite(source, (left, top))
            canvas.convert("RGB").save(output_file)
    except Exception as e:
        _fail(
            "empty_output",
            f"OpenAI image generation succeeded but the slide visual could not be normalized: {type(e).__name__}",
            raw_error=_extract_raw_error(e),
        )


def generate_image(
    prompt_file: str,
    reference_images: list[str],
    output_file: str,
    aspect_ratio: str = "16:9",
    *,
    slide_visual: bool = False,
    size: str | None = None,
) -> str:
    """Generate one image. Returns a status string on success.

    Hard-exits the process on missing API key or any API failure so the
    builder's bash subprocess sees a non-zero exit code and stops looping.
    """
    prompt = _build_prompt(prompt_file, slide_visual=slide_visual)
    quality = "high" if slide_visual else None
    client = _openai_client_from_env()
    valid_refs = _filter_valid_references(reference_images or [])
    resolved_size = _resolve_request_size(
        explicit_size=size,
        slide_visual=slide_visual,
        aspect_ratio=aspect_ratio,
        has_references=bool(valid_refs),
    )
    _emit_generation_request(
        slide_visual=slide_visual,
        quality=quality,
        size=resolved_size,
        prompt=prompt,
    )

    try:
        response = _call_image_api_or_fail(
            client,
            prompt=prompt,
            valid_refs=valid_refs,
            size=resolved_size,
            quality=quality,
        )
    finally:
        _flush_langsmith_traces()
    payload = _extract_payload_or_fail(response)
    _decode_to_file(payload, output_file)
    if slide_visual:
        _normalize_slide_visual_aspect(output_file)
    _assert_output_file_written(output_file)
    _emit_generation_result(output_file, valid_refs)

    return f"IMAGEGEN_OK model={_image_request_model(valid_refs)} output_file={output_file}"


def preflight() -> int:
    """Cheap environment check BEFORE any generation attempt (Spec VQ-3).

    Prints exactly one JSON line so the harness can record WHY image
    generation was skipped instead of inferring it from silence:
      {"preflight": "ok"} → exit 0
      {"preflight": "failed", "reason": "env_missing"|"auth_invalid"|...} → exit 1
    """
    import json as _json

    def _emit(status: str, reason: str | None = None) -> int:
        payload: dict[str, str] = {"preflight": status}
        if reason:
            payload["reason"] = reason
        print(_json.dumps(payload))
        return 0 if status == "ok" else 1

    if not os.environ.get("OPENAI_API_KEY", "").strip():
        return _emit("failed", "env_missing")
    try:
        from openai import OpenAI  # transitive dep via langchain-openai

        client = OpenAI(timeout=10.0, max_retries=0)
        client.models.retrieve(_GENERATE_MODEL)
    except Exception as exc:  # noqa: BLE001 — classify, never crash preflight
        reason = _classify_exception(exc)
        # An unknown-model 404 still proves key+egress work; only hard
        # env/auth/egress failures should block enrichment.
        if reason not in {"auth_invalid", "egress_blocked", "org_not_verified"}:
            return _emit("ok")
        return _emit("failed", reason)
    return _emit("ok")


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate images using OpenAI image models")
    parser.add_argument(
        "--preflight",
        action="store_true",
        help="Check OPENAI_API_KEY + API reachability; print one JSON line; exit 0/1. No generation.",
    )
    parser.add_argument("--prompt-file", help="Absolute path to JSON prompt file")
    parser.add_argument(
        "--reference-images",
        nargs="*",
        default=[],
        help="Absolute paths to reference images (space-separated)",
    )
    parser.add_argument("--output-file", help="Output path for the generated image")
    parser.add_argument(
        "--aspect-ratio",
        default="16:9",
        help="Aspect ratio of the generated image (1:1, 16:9, 4:3, 9:16, 2:3, 3:2)",
    )
    parser.add_argument(
        "--size",
        default=None,
        help=(
            "Explicit OpenAI image size. Defaults to 1536x1024 for --slide-visual generation "
            "and edits, otherwise aspect-ratio mapping."
        ),
    )
    parser.add_argument(
        "--slide-visual",
        action="store_true",
        help="Generate a full-slide PPTX visual: use prompt.prompt, Sophia slide style, quality=high, and 16:9 size.",
    )
    args = parser.parse_args(argv)
    if not args.preflight and (not args.prompt_file or not args.output_file):
        parser.error("--prompt-file and --output-file are required unless --preflight is used")
    return args


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    if args.preflight:
        return preflight()
    print(
        generate_image(
            args.prompt_file,
            args.reference_images,
            args.output_file,
            args.aspect_ratio,
            slide_visual=args.slide_visual,
            size=args.size,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
