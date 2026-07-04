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
import contextvars
import hashlib
import json as _json
import os
import re
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

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
_CAPTURE_FAILURES: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "image_generation_capture_failures",
    default=False,
)
_TRACE_PARENT_OVERRIDE: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "image_generation_trace_parent_override",
    default=None,
)
_OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"
_WORKSPACE_VIRTUAL_PREFIX = "/mnt/user-data/workspace/"
_OUTPUTS_HOST_ENV = "SOPHIA_OUTPUTS_HOST_PATH"
_WORKSPACE_HOST_ENV = "SOPHIA_WORKSPACE_HOST_PATH"

_SOPHIA_SLIDE_STYLE = (
    "Visual system: restrained professional technical presentation visuals with a single "
    "coherent style chosen by the prompt. Preserve that named style faithfully across the "
    "whole deck. Use generous white space, clear hierarchy, precise geometry, and one "
    "confident focal element. "
    "Brand palette: deep ink navy (#1F2A37) for primary text; considered blue (#2E5AAC) "
    "as the lead accent; warm teal (#2A9D8F) and restrained gold (#D4AF37) as secondary "
    "accents; soft coral (#E76F51) sparingly; on light paper (#FFFFFF / #F5F7FA) or a "
    "purposeful dark canvas only when requested or clearly appropriate. Avoid template "
    "sameness; vary diagram structure while keeping the deck's chosen style cohesive. "
    "Looks like a slide visual from a deck that took real design care."
)

_SOPHIA_SLIDE_AVOID = (
    "Avoid: generic AI gradient meshes and purple/pink glow; glossy or plastic 3D render; "
    "oversaturated stock-photo treatment; clip-art, emoji, or decorative borders; busy, "
    "cluttered, or cramped layouts; tiny or low-contrast text; watermarks or logos; "
    "chalkboard, blackboard, whiteboard, handwritten, hand-drawn, sketch, classroom, or "
    "playful styles unless explicitly requested; literal 'AI' clichés (glowing brains, "
    "circuit boards, robots, binary)."
)
_SOPHIA_SLIDE_AVOID = (
    _SOPHIA_SLIDE_AVOID
    + " No purple/pink AI-gradient hero. No single-font template look. "
    + "No generic stock-deck styling."
)

_SOPHIA_SLIDE_ZONE_CONTRACT = (
    "Visual-only slide asset: render ONLY the slide's visual — the diagram, illustration, or chart "
    "— to fill a 16:9 frame. This image is embedded inside the HTML slide's visual region while the "
    "slide title, labels, annotations, formulas, and bottom narrative stay as real HTML text OUTSIDE "
    "the image. Do NOT bake in the slide title, diagram labels, axis labels, formulas, paragraph text, "
    "a bottom narrative band, a footer, page numbers, or any slide chrome unless the user explicitly "
    "requested image-baked typography. Prefer mostly text-free structure, shapes, spatial grouping, "
    "and visual metaphor. Fill the whole frame with the chosen style; avoid unintended blank gutters "
    "or transparent edges."
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
    detail = re.sub(r"\bsk-[A-Za-z0-9_-]+", "sk-[redacted]", detail)
    detail = re.sub(r"\blsv2_[A-Za-z0-9_-]+", "lsv2_[redacted]", detail)
    if len(detail) > _RAW_ERROR_MAX:
        detail = detail[:_RAW_ERROR_MAX] + "...[truncated]"
    return detail


class ImageGenerationFailure(Exception):
    """Structured failure raised inside batch workers instead of exiting."""

    def __init__(
        self,
        reason: str,
        message: str,
        *,
        raw_error: str = "",
        exit_code: int = 1,
    ) -> None:
        super().__init__(message)
        self.reason = reason
        self.message = message
        self.raw_error = raw_error
        self.exit_code = exit_code


def _fail(reason: str, message: str, *, raw_error: str = "", exit_code: int = 1) -> None:
    """Emit one machine-readable failure line plus a short safe message.

    ``raw_error`` carries the truncated RAW provider detail so failures are
    diagnosable from logs alone instead of just ``reason=api_error``. It is
    surfaced both on the machine-readable line and as its own stderr line.
    """
    if _CAPTURE_FAILURES.get():
        raise ImageGenerationFailure(
            reason,
            message,
            raw_error=raw_error,
            exit_code=exit_code,
        )
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
    status_code = getattr(exc, "status_code", None)
    code = str(getattr(exc, "code", "") or "").lower()
    if isinstance(exc, (ImportError, ModuleNotFoundError)):
        return "import_error"
    if isinstance(exc, PermissionError):
        return "permission_denied"
    if isinstance(exc, FileNotFoundError):
        return "file_not_found"
    if "organization" in text and ("verified" in text or "verify" in text):
        return "org_not_verified"
    if any(token in text for token in ("invalid api key", "incorrect api key", "401", "unauthorized", "authentication")):
        return "auth_invalid"
    if "insufficient_quota" in code or any(
        token in text for token in ("insufficient_quota", "quota", "billing hard limit", "exceeded your current quota")
    ):
        return "quota_exceeded"
    if status_code == 429 or "rate_limit" in code or any(
        token in text for token in ("rate limit", "rate_limit", "too many requests", "429")
    ):
        return "rate_limit"
    if status_code in {500, 502, 503, 504} or any(
        token in text
        for token in (
            "internal server error",
            "bad gateway",
            "service unavailable",
            "gateway timeout",
            "server error",
            "500",
            "502",
            "503",
            "504",
        )
    ):
        return "server_error"
    if any(token in text for token in ("content policy", "content_policy", "safety", "blocked", "moderation")):
        return "content_blocked"
    if any(token in text for token in ("timeout", "timed out", "readtimeout")):
        return "timeout"
    if any(token in text for token in ("connection", "connecterror", "network", "proxy", "name resolution", "dns")):
        return "egress_blocked"
    if "reference image" in text or "invalid_reference" in text:
        return "invalid_reference_image"
    if "size" in text and any(token in text for token in ("invalid", "unsupported", "not one of")):
        return "invalid_size"
    if "empty output" in text or "no usable image bytes" in text or "no bytes landed" in text:
        return "empty_output"
    return "api_error"


def _env_flag_preferred(*names: str) -> bool:
    for name in names:
        value = os.getenv(name)
        if value is not None and value.strip():
            return value.strip().lower() in _TRUTHY_VALUES
    return False


def _env_flag_value(name: str) -> bool | None:
    value = os.getenv(name)
    if value is None or not value.strip():
        return None
    return value.strip().lower() in _TRUTHY_VALUES


def _env_value(*names: str) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value and value.strip():
            return value.strip().strip('"').strip("'").strip()
    return None


def _langsmith_tracing_configured() -> bool:
    builder_flag = _env_flag_value("SOPHIA_BUILDER_LANGSMITH_TRACING")
    tracing_requested = (
        builder_flag
        if builder_flag is not None
        else _env_flag_preferred("LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2", "LANGCHAIN_TRACING")
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
    return _TRACE_PARENT_OVERRIDE.get() or _env_value("SOPHIA_PARENT_DOTTED_ORDER", "LANGSMITH_DOTTED_ORDER")


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
    prompt_chars = len(prompt)
    return {
        "provider": "openai",
        "model": model,
        "endpoint": "images.edit" if valid_refs else "images.generate",
        "prompt_hash": hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:16],
        "prompt_chars": prompt_chars,
        "prompt_truncated": prompt_chars > _TRACE_PROMPT_MAX,
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


def _langsmith_tool_trace_context(
    name: str,
    *,
    inputs: dict[str, Any],
    metadata: dict[str, Any] | None = None,
    tags: list[str] | None = None,
    parent: Any | None = None,
) -> Any | None:
    client = _langsmith_client()
    if client is None:
        return None
    try:
        from langsmith import trace, tracing_context

        project_name = _langsmith_project_name()
        trace_metadata = {
            "sophia_component": "builder_image_generation",
            **_langsmith_parent_metadata(),
            **(metadata or {}),
        }
        trace_parent = parent if parent is not None else _langsmith_parent_for_trace()
        trace_tags = ["sophia", "image_generation", *(tags or [])]
        enabled_context = tracing_context(
            enabled=True,
            client=client,
            project_name=project_name,
            parent=trace_parent,
            tags=trace_tags,
            metadata=trace_metadata,
        )
        trace_context = trace(
            name,
            run_type="tool",
            project_name=project_name,
            inputs=inputs,
            metadata=trace_metadata,
            tags=trace_tags,
            client=client,
            parent=trace_parent,
        )
        return _EnabledLangSmithTraceContext(enabled_context, trace_context)
    except Exception:
        return None


def _langsmith_trace_context(*, prompt: str, valid_refs: list[str], size: str, quality: str | None) -> Any | None:
    model = _image_request_model(valid_refs)
    return _langsmith_tool_trace_context(
        "Sophia Image Generation OpenAI Call",
        inputs=_image_trace_inputs(prompt=prompt, valid_refs=valid_refs, size=size, quality=quality),
        metadata={
            "ls_provider": "openai",
            "ls_model_name": model,
            "image_endpoint": "edit" if valid_refs else "generate",
        },
        tags=["openai"],
    )


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


def _safe_relative_virtual_path(value: str) -> Path | None:
    normalized = value.replace("\\", "/").strip()
    if not normalized:
        return None
    parts = Path(normalized).parts
    if any(part == ".." for part in parts):
        return None
    return Path(*parts) if parts else None


def _virtual_mapping(value: str) -> tuple[str, str] | None:
    normalized = value.replace("\\", "/").strip()
    for prefix, env_name in (
        (_OUTPUTS_VIRTUAL_PREFIX, _OUTPUTS_HOST_ENV),
        (_WORKSPACE_VIRTUAL_PREFIX, _WORKSPACE_HOST_ENV),
    ):
        if normalized.startswith(prefix):
            return env_name, normalized[len(prefix):].lstrip("/")
    return None


def _resolve_sophia_path(
    value: str,
    *,
    base_dir: Path | None = None,
    for_output: bool = False,
) -> str:
    """Map Sophia virtual paths to the host filesystem when the harness exports roots."""
    raw = str(value or "").strip()
    if not raw:
        return raw
    path = Path(raw)
    if path.exists() or (for_output and path.is_absolute() and not _virtual_mapping(raw)):
        return str(path)
    mapping = _virtual_mapping(raw)
    if mapping is not None:
        env_name, relative_raw = mapping
        root = os.environ.get(env_name, "").strip()
        relative = _safe_relative_virtual_path(relative_raw)
        if root and relative is not None:
            return str(Path(root) / relative)
    if base_dir is not None and not path.is_absolute():
        relative = _safe_relative_virtual_path(raw)
        if relative is not None:
            return str(base_dir / relative)
    return raw


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


def _load_pillow_image() -> Any:
    try:
        from PIL import Image
    except ImportError as exc:
        _fail(
            "import_error",
            f"Pillow is not available in the sandbox: {type(exc).__name__}",
            raw_error=_extract_raw_error(exc),
            exit_code=2,
        )
    return Image


def _validate_reference_image(image_path: str) -> bool:
    """True iff Pillow can fully load the file as an image."""
    Image = _load_pillow_image()
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


def _image_gen_timeout_seconds() -> float:
    """Per-call generation timeout. Bounds a single hung image-gen request.

    Default 120s: gpt-image calls complete in well under ~2 min, so a 120s bound
    fails a genuinely-stuck request fast and frees the worker thread (the old 600s
    default equalled the whole sandbox budget and let one slow call wedge a batch).
    The client retries transient 429/5xx within this bound (see max_retries below),
    so a brief rate-limit recovers instead of dying instantly.
    """
    raw = (os.getenv("SOPHIA_IMAGE_GEN_TIMEOUT") or "").strip()
    try:
        value = float(raw)
    except ValueError:
        return 120.0
    return value if value > 0 else 120.0


def _image_gen_max_retries() -> int:
    """SDK retry budget for transient 429/5xx/connection errors.

    Default 3 (overridable via SOPHIA_IMAGE_GEN_MAX_RETRIES). The OpenAI SDK
    retries only transient classes (rate-limit / server / connection) with
    exponential backoff and leaves user errors (bad request, content policy,
    org-not-verified) alone. This is the yield fix: the prod batch saw 2/20
    success with max_retries=0 because concurrent calls hit 429 and died with no
    retry; the 2 successes prove the model/key/verification are fine, so the rest
    were transient and recoverable.
    """
    raw = (os.getenv("SOPHIA_IMAGE_GEN_MAX_RETRIES") or "").strip()
    try:
        value = int(raw)
    except ValueError:
        return 3
    return value if value >= 0 else 3


def _openai_client_from_env() -> object:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        _fail("missing_api_key", "OPENAI_API_KEY is not set", exit_code=2)
    try:
        from openai import OpenAI  # transitive dep via langchain-openai
    except ImportError as e:  # pragma: no cover - sandbox should always have this
        _fail(
            "import_error",
            f"openai SDK is not available in the sandbox: {type(e).__name__}",
            raw_error=_extract_raw_error(e),
            exit_code=2,
        )
    return OpenAI(api_key=api_key, timeout=_image_gen_timeout_seconds(), max_retries=_image_gen_max_retries())


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
    prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:16]
    print(f"[gen] PROMPT_SENT: sha256={prompt_hash} chars={len(prompt)}")
    if _env_flag_preferred("SOPHIA_IMAGE_GENERATION_DEBUG_PROMPT"):
        print(f"[gen] PROMPT_SENT_FULL: {prompt}")


def _emit_generation_result(output_file: str, valid_refs: list[str]) -> None:
    path = Path(output_file)
    ext = path.suffix.lower() or ""
    n_bytes = path.stat().st_size if path.exists() else 0
    print(f"[gen] result: ext={ext} bytes={n_bytes} ref_images={len(valid_refs)}")


def _assert_output_file_written(output_file: str) -> None:
    if not Path(output_file).exists() or Path(output_file).stat().st_size == 0:
        _fail("empty_output", "OpenAI image generation succeeded but no bytes landed on disk")


def _normalize_slide_visual_aspect(output_file: str) -> None:
    Image = _load_pillow_image()
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
                crop_width = max(1, round(height * _SLIDE_VISUAL_ASPECT_RATIO))
                left = max(0, (width - crop_width) // 2)
                source = source.crop((left, 0, left + crop_width, height))
            else:
                crop_height = max(1, round(width / _SLIDE_VISUAL_ASPECT_RATIO))
                top = max(0, (height - crop_height) // 2)
                source = source.crop((0, top, width, top + crop_height))
            source.convert("RGB").save(output_file)
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
    actual_prompt_file = _resolve_sophia_path(prompt_file)
    actual_output_file = _resolve_sophia_path(output_file, for_output=True)
    actual_reference_images = [_resolve_sophia_path(path) for path in (reference_images or [])]

    prompt = _build_prompt(actual_prompt_file, slide_visual=slide_visual)
    quality = "high" if slide_visual else None
    client = _openai_client_from_env()
    valid_refs = _filter_valid_references(actual_reference_images)
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
    _decode_to_file(payload, actual_output_file)
    if slide_visual:
        _normalize_slide_visual_aspect(actual_output_file)
    _assert_output_file_written(actual_output_file)
    _emit_generation_result(actual_output_file, valid_refs)

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
    parser.add_argument(
        "--manifest",
        default=None,
        help=(
            "Absolute path to a JSON batch manifest: "
            '{"items": [{"prompt_file", "output_file", "reference_images"?, '
            '"aspect_ratio"?, "slide_visual"?, "size"?}, ...], "concurrency"?: int}. '
            "Generates all items concurrently (bounded by SOPHIA_IMAGE_GEN_CONCURRENCY, "
            "default 2). Mutually exclusive with --prompt-file/--output-file."
        ),
    )
    args = parser.parse_args(argv)
    if not args.preflight and not args.manifest and (not args.prompt_file or not args.output_file):
        parser.error("--prompt-file and --output-file are required unless --preflight or --manifest is used")
    return args


def _safe_basename(value: object) -> str:
    try:
        return Path(str(value or "")).name
    except Exception:
        return str(value or "")


def _safe_prompt_hash(prompt_file: object, *, slide_visual: bool, base_dir: Path | None = None) -> str | None:
    if not prompt_file:
        return None
    resolved = _resolve_sophia_path(str(prompt_file), base_dir=base_dir)
    try:
        prompt = _build_prompt(resolved, slide_visual=slide_visual)
    except Exception:
        try:
            prompt = Path(resolved).read_text(encoding="utf-8")
        except Exception:
            return None
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:16]


def _batch_item_trace_inputs(item: dict, index: int, *, manifest_dir: Path | None = None) -> dict[str, Any]:
    refs = list(item.get("reference_images") or [])
    slide_visual = bool(item.get("slide_visual"))
    return {
        "item_index": index,
        "prompt_file": _safe_basename(item.get("prompt_file")),
        "prompt_hash": _safe_prompt_hash(item.get("prompt_file"), slide_visual=slide_visual, base_dir=manifest_dir),
        "output_file": _safe_basename(item.get("output_file")),
        "reference_image_count": len(refs),
        "reference_images": [_safe_basename(path) for path in refs],
        "endpoint": "images.edit" if refs else "images.generate",
        "slide_visual": slide_visual,
        "size": item.get("size"),
        "aspect_ratio": item.get("aspect_ratio") or "16:9",
    }


def _batch_trace_inputs(
    *,
    manifest_path: str,
    items: list,
    concurrency: int,
    requested_concurrency: object,
    max_concurrency: int,
    manifest_dir: Path | None = None,
) -> dict[str, Any]:
    normalized_items = [item for item in items if isinstance(item, dict)]
    return {
        "manifest_file": _safe_basename(manifest_path),
        "requested": len(items),
        "concurrency": concurrency,
        "requested_concurrency": requested_concurrency,
        "max_concurrency": max_concurrency,
        "sdk_timeout_seconds": _image_gen_timeout_seconds(),
        "sdk_max_retries": _image_gen_max_retries(),
        "items": [
            {
                "item_index": index,
                "prompt_file": _safe_basename(item.get("prompt_file")),
                "prompt_hash": _safe_prompt_hash(
                    item.get("prompt_file"),
                    slide_visual=bool(item.get("slide_visual")),
                    base_dir=manifest_dir,
                ),
                "output_file": _safe_basename(item.get("output_file")),
                "reference_image_count": len(list(item.get("reference_images") or [])),
                "endpoint": "images.edit" if item.get("reference_images") else "images.generate",
            }
            for index, item in enumerate(normalized_items, start=1)
        ],
    }


def _error_histogram(results: list[dict]) -> dict[str, int]:
    return dict(
        Counter(
            str(result.get("error_class") or result.get("error") or "unknown")
            for result in results
            if not result.get("success")
        )
    )


def _finish_trace(run: Any, *, outputs: dict[str, Any]) -> None:
    if run is None:
        return
    try:
        run.end(outputs=outputs)
    except Exception:
        pass


def _system_exit_code(exc: SystemExit) -> int:
    code = exc.code
    if isinstance(code, int):
        return code if code != 0 else 1
    if isinstance(code, str) and code.strip().isdigit():
        value = int(code.strip())
        return value if value != 0 else 1
    return 1


def _manifest_items_for_failure_summary(manifest_path: str) -> tuple[int, list[dict[str, Any]]]:
    try:
        resolved_manifest_path = _resolve_sophia_path(manifest_path)
        manifest_dir = Path(resolved_manifest_path).parent
        manifest = _json.loads(Path(resolved_manifest_path).read_text(encoding="utf-8"))
    except Exception:
        return 0, []
    raw_items = manifest.get("items") if isinstance(manifest, dict) else None
    if not isinstance(raw_items, list):
        return 0, []
    items: list[dict[str, Any]] = []
    for index, item in enumerate(raw_items, start=1):
        if not isinstance(item, dict):
            items.append(
                {
                    "item_index": index,
                    "success": False,
                    "error": "invalid_manifest_item",
                    "error_class": "invalid_manifest_item",
                }
            )
            continue
        prompt_file = str(item.get("prompt_file") or "")
        prompt_actual = _resolve_sophia_path(prompt_file, base_dir=manifest_dir) if prompt_file else ""
        prompt_readable = bool(prompt_actual and Path(prompt_actual).is_file())
        items.append(
            {
                "item_index": index,
                "prompt_file": _safe_basename(prompt_file),
                "prompt_readable": prompt_readable,
                "prompt_hash": (
                    _safe_prompt_hash(prompt_file, slide_visual=bool(item.get("slide_visual")), base_dir=manifest_dir)
                    if prompt_readable
                    else None
                ),
                "output_file": str(item.get("output_file") or ""),
                "success": False,
            }
        )
    return len(raw_items), items


def _emit_manifest_startup_failure(manifest_path: str, exc: BaseException, *, exit_code: int = 1) -> int:
    error_class = "process_exit" if isinstance(exc, SystemExit) else _classify_exception(exc)
    raw_error = _extract_raw_error(exc)
    requested, items = _manifest_items_for_failure_summary(manifest_path)
    item_error = f"{type(exc).__name__}: {exc}"
    for item in items:
        item.setdefault("error", item_error)
        item.setdefault("error_class", error_class)
        item.setdefault("raw_error_excerpt", raw_error)
        item.setdefault("exit_code", exit_code)
    payload = {
        "images_generated": 0,
        "requested": requested,
        "failed": requested,
        "complete": False,
        "error": item_error,
        "error_class": error_class,
        "raw_error_excerpt": raw_error,
        "exit_code": exit_code,
        "items": items,
        "error_class_histogram": {error_class: requested or 1},
    }
    print(f"IMAGEGEN_BATCH {_json.dumps(payload)}")
    _flush_langsmith_traces()
    return exit_code if exit_code else 1


def _run_batch(manifest_path: str) -> int:
    """Generate multiple images concurrently from a JSON manifest.

    Deck builds (and PDF reports' few conceptual images) generate visuals in a
    single parallel batch instead of one serial call per turn. Manifest shape::

        {"items": [{"prompt_file", "output_file", "reference_images"?,
                     "aspect_ratio"?, "slide_visual"?, "size"?}, ...],
         "concurrency"?: int}

    Each item runs the same per-image pipeline as single mode. One item's
    failure is ISOLATED — ``generate_image()`` hard-exits via ``sys.exit`` on
    failure, which we catch per worker so a single bad image never aborts the
    batch. Prints exactly one ``IMAGEGEN_BATCH`` JSON summary line on stdout;
    exits 0 only when every requested image succeeds, else 1 with structured
    per-item failures. Deck style consistency is the caller's job: use the same
    style instructions across prompt files and optional ``reference_images``.
    """
    import json as _json
    from concurrent.futures import ThreadPoolExecutor

    batch_run: Any | None = None

    def _summary(payload: dict) -> int:
        payload.setdefault("failed", max(0, int(payload.get("requested") or 0) - int(payload.get("images_generated") or 0)))
        payload.setdefault("complete", bool(payload.get("requested")) and payload.get("images_generated") == payload.get("requested"))
        print(f"IMAGEGEN_BATCH {_json.dumps(payload)}")
        _finish_trace(batch_run, outputs=payload)
        _flush_langsmith_traces()
        return 0 if payload.get("complete") else 1

    resolved_manifest_path = _resolve_sophia_path(manifest_path)
    manifest_dir = Path(resolved_manifest_path).parent
    try:
        manifest = _json.loads(Path(resolved_manifest_path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return _summary(
            {
                "images_generated": 0,
                "requested": 0,
                "complete": False,
                "error": f"manifest_unreadable: {exc}",
                "error_class": "manifest_unreadable",
                "raw_error_excerpt": _extract_raw_error(exc),
                "items": [],
                "error_class_histogram": {"manifest_unreadable": 1},
            }
        )
    items = manifest.get("items") if isinstance(manifest, dict) else None
    if not isinstance(items, list) or not items:
        return _summary(
            {
                "images_generated": 0,
                "requested": 0,
                "complete": False,
                "error": "manifest_empty",
                "error_class": "manifest_empty",
                "items": [],
                "error_class_histogram": {"manifest_empty": 1},
            }
        )

    # Default 2: keep the parallel speed win but stay within lower image RPM tiers
    # while the per-call retries recover transient 429/5xx instead of re-saturating.
    # Override via SOPHIA_IMAGE_GEN_CONCURRENCY after traces prove a higher stable tier.
    env_conc = os.environ.get("SOPHIA_IMAGE_GEN_CONCURRENCY", "").strip()
    max_concurrency = int(env_conc) if env_conc.isdigit() and int(env_conc) > 0 else 2
    concurrency = max_concurrency
    requested_conc = manifest.get("concurrency")
    if isinstance(requested_conc, int) and requested_conc > 0:
        concurrency = min(requested_conc, max_concurrency)
    concurrency = max(1, min(concurrency, len(items)))

    batch_context = _langsmith_tool_trace_context(
        "Sophia Image Batch",
        inputs=_batch_trace_inputs(
            manifest_path=manifest_path,
            items=items,
            concurrency=concurrency,
            requested_concurrency=requested_conc,
            max_concurrency=max_concurrency,
            manifest_dir=manifest_dir,
        ),
        metadata={
            "sophia_component": "builder_image_batch",
            "manifest_file": _safe_basename(manifest_path),
            "image_batch_requested_count": len(items),
            "image_batch_concurrency": concurrency,
            "image_batch_requested_concurrency": requested_conc,
            "image_batch_max_concurrency": max_concurrency,
        },
        tags=["batch"],
    )

    def _one(index_and_item: tuple[int, dict]) -> dict:
        index, item = index_and_item
        started = time.perf_counter()
        out = str(item.get("output_file") or "")
        prompt_file = str(item.get("prompt_file") or "")
        prompt_actual = _resolve_sophia_path(prompt_file, base_dir=manifest_dir)
        out_actual = _resolve_sophia_path(out, base_dir=manifest_dir, for_output=True)
        refs_actual = [
            _resolve_sophia_path(str(ref), base_dir=manifest_dir)
            for ref in list(item.get("reference_images") or [])
        ]
        item_context = _langsmith_tool_trace_context(
            "Sophia Image Batch Item",
            inputs=_batch_item_trace_inputs(item, index, manifest_dir=manifest_dir),
            metadata={
                "sophia_component": "builder_image_batch_item",
                "image_batch_item_index": index,
                "image_endpoint": "edit" if item.get("reference_images") else "generate",
            },
            tags=["batch_item"],
            parent=getattr(batch_run, "dotted_order", None),
        )
        with (item_context or contextlib.nullcontext()) as item_run:
            if not item.get("prompt_file") or not out:
                result = {
                    "item_index": index,
                    "output_file": out,
                    "success": False,
                    "error": "missing_prompt_or_output",
                    "error_class": "missing_prompt_or_output",
                    "duration_ms": int((time.perf_counter() - started) * 1000),
                }
                _finish_trace(item_run, outputs=result)
                return result
            if not Path(prompt_actual).is_file():
                result = {
                    "item_index": index,
                    "output_file": out,
                    "success": False,
                    "error": "manifest_prompt_missing",
                    "error_class": "manifest_prompt_missing",
                    "duration_ms": int((time.perf_counter() - started) * 1000),
                }
                _finish_trace(item_run, outputs=result)
                return result
            capture_token = _CAPTURE_FAILURES.set(True)
            parent_token = _TRACE_PARENT_OVERRIDE.set(getattr(item_run, "dotted_order", None))
            try:
                status = generate_image(
                    prompt_actual,
                    refs_actual,
                    out_actual,
                    str(item.get("aspect_ratio") or "16:9"),
                    slide_visual=bool(item.get("slide_visual")),
                    size=item.get("size"),
                )
                bytes_count = Path(out_actual).stat().st_size if Path(out_actual).is_file() else 0
                result = {
                    "item_index": index,
                    "output_file": out,
                    "success": True,
                    "status": status,
                    "bytes": bytes_count,
                    "duration_ms": int((time.perf_counter() - started) * 1000),
                }
            except ImageGenerationFailure as exc:
                result = {
                    "item_index": index,
                    "output_file": out,
                    "success": False,
                    "error": exc.message,
                    "error_class": exc.reason,
                    "raw_error_excerpt": exc.raw_error,
                    "exit_code": exc.exit_code,
                    "duration_ms": int((time.perf_counter() - started) * 1000),
                }
            except SystemExit as exc:  # defensive: isolate any uncaptured legacy hard-exit
                result = {
                    "item_index": index,
                    "output_file": out,
                    "success": False,
                    "error": f"exit_{exc.code}",
                    "error_class": "process_exit",
                    "exit_code": exc.code,
                    "duration_ms": int((time.perf_counter() - started) * 1000),
                }
            except Exception as exc:  # noqa: BLE001 — one bad image must never abort the batch
                result = {
                    "item_index": index,
                    "output_file": out,
                    "success": False,
                    "error": f"{type(exc).__name__}: {exc}",
                    "error_class": _classify_exception(exc),
                    "raw_error_excerpt": _extract_raw_error(exc),
                    "duration_ms": int((time.perf_counter() - started) * 1000),
                }
            finally:
                _TRACE_PARENT_OVERRIDE.reset(parent_token)
                _CAPTURE_FAILURES.reset(capture_token)
            _finish_trace(item_run, outputs=result)
            return result

    with (batch_context or contextlib.nullcontext()) as run:
        batch_run = run
        try:
            with ThreadPoolExecutor(max_workers=concurrency) as pool:
                results = list(pool.map(_one, enumerate(items, start=1)))
        except Exception as exc:  # noqa: BLE001 - still emit the batch contract on executor-level failure.
            return _summary(
                {
                    "images_generated": 0,
                    "requested": len(items),
                    "failed": len(items),
                    "complete": False,
                    "concurrency": concurrency,
                    "requested_concurrency": requested_conc,
                    "max_concurrency": max_concurrency,
                    "error": f"{type(exc).__name__}: {exc}",
                    "error_class": _classify_exception(exc),
                    "raw_error_excerpt": _extract_raw_error(exc),
                    "items": [],
                }
            )
        succeeded = sum(1 for r in results if r.get("success"))
        errors = _error_histogram(results)
        return _summary(
            {
                "images_generated": succeeded,
                "requested": len(items),
                "failed": len(items) - succeeded,
                "complete": succeeded == len(items),
                "concurrency": concurrency,
                "requested_concurrency": requested_conc,
                "max_concurrency": max_concurrency,
                "error_class_histogram": errors,
                "items": results,
            }
        )


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    if args.preflight:
        return preflight()
    if args.manifest:
        try:
            return _run_batch(args.manifest)
        except SystemExit as exc:
            return _emit_manifest_startup_failure(args.manifest, exc, exit_code=_system_exit_code(exc))
        except Exception as exc:  # noqa: BLE001 - manifest mode must always emit IMAGEGEN_BATCH.
            return _emit_manifest_startup_failure(args.manifest, exc, exit_code=1)
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
