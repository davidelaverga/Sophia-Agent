"""Image generation script for the ``image-generation`` skill.

Backed by OpenAI's ``gpt-image-2`` model. Wraps two endpoints:

- ``client.images.generate(...)`` for prompts without reference images.
- ``client.images.edit(...)``     for prompts that condition on one or more
  reference images. This is the path ``ppt-generation`` uses to keep visual
  consistency across slides ("use the previous slide as a reference for the
  next slide").

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
import os
import sys
from pathlib import Path

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

_MODEL = "gpt-image-2"


def _resolve_size(aspect_ratio: str) -> str:
    return _ASPECT_TO_SIZE.get((aspect_ratio or "").strip(), _DEFAULT_SIZE)


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
    valid = [p for p in reference_images if _validate_reference_image(p)]
    if len(valid) < len(reference_images):
        skipped = len(reference_images) - len(valid)
        print(f"Note: {skipped} reference image(s) were skipped due to validation failure.", file=sys.stderr)
    return valid


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


def generate_image(
    prompt_file: str,
    reference_images: list[str],
    output_file: str,
    aspect_ratio: str = "16:9",
) -> str:
    """Generate one image. Returns a status string on success.

    Hard-exits the process on missing API key or any API failure so the
    builder's bash subprocess sees a non-zero exit code and stops looping.
    """
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        # See module docstring — silent failure here was the root cause of
        # the 21-minute .pptx loop documented in COMPOUND_LOG.md.
        print("OPENAI_API_KEY is not set", file=sys.stderr)
        sys.exit(2)

    try:
        from openai import OpenAI  # transitive dep via langchain-openai
    except ImportError as e:  # pragma: no cover - sandbox should always have this
        print(f"openai SDK is not available in the sandbox: {e}", file=sys.stderr)
        sys.exit(2)

    with open(prompt_file, encoding="utf-8") as f:
        prompt = f.read()

    size = _resolve_size(aspect_ratio)
    client = OpenAI(api_key=api_key)

    valid_refs = _filter_valid_references(reference_images or [])

    try:
        if valid_refs:
            # /v1/images/edits accepts one or more reference images. Pass
            # the file handles directly so multipart upload works.
            ref_handles = [open(p, "rb") for p in valid_refs]
            try:
                response = client.images.edit(
                    model=_MODEL,
                    image=ref_handles if len(ref_handles) > 1 else ref_handles[0],
                    prompt=prompt,
                    size=size,
                )
            finally:
                for fh in ref_handles:
                    fh.close()
        else:
            response = client.images.generate(
                model=_MODEL,
                prompt=prompt,
                size=size,
            )
    except Exception as e:
        print(f"OpenAI image generation failed: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)

    payload = _extract_b64(response)
    _decode_to_file(payload, output_file)

    if not Path(output_file).exists() or Path(output_file).stat().st_size == 0:
        print(f"OpenAI image generation succeeded but no bytes landed at {output_file}", file=sys.stderr)
        sys.exit(1)

    return f"Successfully generated image to {output_file}"


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate images using OpenAI gpt-image-2")
    parser.add_argument("--prompt-file", required=True, help="Absolute path to JSON prompt file")
    parser.add_argument(
        "--reference-images",
        nargs="*",
        default=[],
        help="Absolute paths to reference images (space-separated)",
    )
    parser.add_argument("--output-file", required=True, help="Output path for the generated image")
    parser.add_argument(
        "--aspect-ratio",
        default="16:9",
        help="Aspect ratio of the generated image (1:1, 16:9, 4:3, 9:16, 2:3, 3:2)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    print(
        generate_image(
            args.prompt_file,
            args.reference_images,
            args.output_file,
            args.aspect_ratio,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
