"""Tests for ``skills/public/image-generation/scripts/generate.py``.

The script lives outside the ``backend/`` package so we load it via
``importlib`` rather than a normal import. Subprocess tests cover the
hard-fail-on-missing-key path that must work without any of our test
machinery (the bash tool will call the bare script in production).
"""

from __future__ import annotations

import base64
import importlib.util
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPT_PATH = _REPO_ROOT / "skills" / "public" / "image-generation" / "scripts" / "generate.py"


@pytest.fixture
def script_module():
    """Load the script as an importable module so we can patch its symbols."""
    spec = importlib.util.spec_from_file_location("image_generation_script", _SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


class TestAspectRatioMapping:
    @pytest.mark.parametrize(
        "ratio, expected",
        [
            ("1:1", "1024x1024"),
            ("16:9", "1536x1024"),
            ("4:3", "1024x1024"),
            ("9:16", "1024x1536"),
            ("2:3", "1024x1536"),
            ("3:2", "1536x1024"),
        ],
    )
    def test_known_ratios_map_to_supported_sizes(self, script_module, ratio: str, expected: str) -> None:
        assert script_module._resolve_size(ratio) == expected

    def test_unknown_ratio_falls_back_to_landscape_default(self, script_module) -> None:
        assert script_module._resolve_size("nonsense") == "1536x1024"

    def test_empty_ratio_falls_back_to_default(self, script_module) -> None:
        assert script_module._resolve_size("") == "1536x1024"


# ---------------------------------------------------------------------------
# Subprocess: OPENAI_API_KEY missing → exit 2
# ---------------------------------------------------------------------------


class TestMissingApiKeyHardFails:
    def test_subprocess_exits_with_code_2_when_key_missing(self, tmp_path: Path) -> None:
        prompt_file = tmp_path / "prompt.json"
        prompt_file.write_text("{}", encoding="utf-8")
        output_file = tmp_path / "out.png"

        env = {k: v for k, v in os.environ.items() if k != "OPENAI_API_KEY"}
        result = subprocess.run(
            [
                sys.executable,
                str(_SCRIPT_PATH),
                "--prompt-file",
                str(prompt_file),
                "--output-file",
                str(output_file),
                "--aspect-ratio",
                "16:9",
            ],
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert result.returncode == 2, result.stderr
        assert "IMAGEGEN_FAIL reason=missing_api_key" in result.stderr
        assert "OPENAI_API_KEY is not set" in result.stderr
        assert not output_file.exists()


# ---------------------------------------------------------------------------
# generate_image: mock the OpenAI client to assert call shape
# ---------------------------------------------------------------------------


def _fake_b64_image() -> str:
    return base64.b64encode(b"\x89PNG\r\n\x1a\nfake-image-bytes").decode("ascii")


def _make_response_with_b64(b64: str | None) -> Any:
    item = SimpleNamespace(b64_json=b64) if b64 is not None else SimpleNamespace(b64_json=None)
    return SimpleNamespace(data=[item])


class TestGeneratePathWithoutReferenceImages:
    def test_calls_images_generate_with_expected_args_and_writes_bytes(
        self, script_module, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

        prompt_file = tmp_path / "prompt.json"
        prompt_file.write_text("a clear blue sky", encoding="utf-8")
        output_file = tmp_path / "out.png"

        fake_client = MagicMock()
        fake_client.images.generate.return_value = _make_response_with_b64(_fake_b64_image())
        with patch("openai.OpenAI", return_value=fake_client) as openai_ctor:
            result = script_module.generate_image(
                prompt_file=str(prompt_file),
                reference_images=[],
                output_file=str(output_file),
                aspect_ratio="16:9",
            )

        openai_ctor.assert_called_once_with(api_key="sk-test")
        fake_client.images.generate.assert_called_once_with(
            model="gpt-image-2",
            prompt=f"a clear blue sky\n\n{script_module._SOPHIA_IMAGE_STYLE}\n\n{script_module._SOPHIA_IMAGE_AVOID}",
            size="1536x1024",
        )
        fake_client.images.edit.assert_not_called()
        assert output_file.exists()
        assert output_file.stat().st_size > 0
        assert "IMAGEGEN_OK model=gpt-image-2" in result


class TestEditPathWithReferenceImages:
    def test_calls_images_edit_when_one_reference_image_provided(
        self, script_module, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

        prompt_file = tmp_path / "prompt.json"
        prompt_file.write_text("variation of the input", encoding="utf-8")
        ref_file = tmp_path / "ref.png"
        ref_file.write_bytes(_real_png_bytes())
        output_file = tmp_path / "out.png"

        fake_client = MagicMock()
        fake_client.images.edit.return_value = _make_response_with_b64(_fake_b64_image())
        with patch("openai.OpenAI", return_value=fake_client):
            script_module.generate_image(
                prompt_file=str(prompt_file),
                reference_images=[str(ref_file)],
                output_file=str(output_file),
                aspect_ratio="1:1",
            )

        fake_client.images.generate.assert_not_called()
        fake_client.images.edit.assert_called_once()
        kwargs = fake_client.images.edit.call_args.kwargs
        assert kwargs["model"] == "gpt-image-2"
        assert kwargs["prompt"] == (
            f"variation of the input\n\n{script_module._SOPHIA_IMAGE_STYLE}\n\n"
            f"{script_module._SOPHIA_IMAGE_AVOID}"
        )
        assert kwargs["size"] == "1024x1024"
        assert "quality" not in kwargs
        # When exactly one reference is provided, pass a single file handle
        # (not a list) — matches the OpenAI SDK's expectation.
        assert not isinstance(kwargs["image"], list)

    def test_default_mode_preserves_structured_prompt_fields(
        self, script_module, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

        prompt_file = tmp_path / "prompt.json"
        prompt_file.write_text(
            (
                '{"prompt": "Portrait of Sophia", '
                '"style": "editorial watercolor", '
                '"composition": {"framing": "three-quarter", "negative_space": true}, '
                '"lighting": ["soft window light", "gold rim"]}'
            ),
            encoding="utf-8",
        )
        ref_file = tmp_path / "ref.png"
        ref_file.write_bytes(_real_png_bytes())
        output_file = tmp_path / "out.png"

        fake_client = MagicMock()
        fake_client.images.edit.return_value = _make_response_with_b64(_fake_b64_image())
        with patch("openai.OpenAI", return_value=fake_client):
            script_module.generate_image(
                prompt_file=str(prompt_file),
                reference_images=[str(ref_file)],
                output_file=str(output_file),
                aspect_ratio="1:1",
            )

        prompt = fake_client.images.edit.call_args.kwargs["prompt"]
        assert "Portrait of Sophia" in prompt
        assert "style: editorial watercolor" in prompt
        assert 'composition: {"framing": "three-quarter", "negative_space": true}' in prompt
        assert 'lighting: ["soft window light", "gold rim"]' in prompt
        assert script_module._SOPHIA_IMAGE_STYLE in prompt

    def test_calls_images_edit_with_list_when_multiple_references(
        self, script_module, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

        prompt_file = tmp_path / "prompt.json"
        prompt_file.write_text("compose these", encoding="utf-8")
        ref1 = tmp_path / "ref1.png"
        ref2 = tmp_path / "ref2.png"
        ref1.write_bytes(_real_png_bytes())
        ref2.write_bytes(_real_png_bytes())
        output_file = tmp_path / "out.png"

        fake_client = MagicMock()
        fake_client.images.edit.return_value = _make_response_with_b64(_fake_b64_image())
        with patch("openai.OpenAI", return_value=fake_client):
            script_module.generate_image(
                prompt_file=str(prompt_file),
                reference_images=[str(ref1), str(ref2)],
                output_file=str(output_file),
                aspect_ratio="16:9",
            )

        kwargs = fake_client.images.edit.call_args.kwargs
        assert isinstance(kwargs["image"], list)
        assert len(kwargs["image"]) == 2


class TestSlideVisualMode:
    def test_slide_visual_reference_size_uses_supported_edit_size(self, script_module) -> None:
        assert (
            script_module._resolve_request_size(
                explicit_size=None,
                slide_visual=True,
                aspect_ratio="16:9",
                has_references=True,
            )
            == "1536x1024"
        )

    def test_slide_visual_uses_prompt_field_true_16x9_and_high_quality(
        self, script_module, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

        prompt_file = tmp_path / "slide.json"
        prompt_file.write_text(
            '{"prompt": "A professional slide. Title: \\"THE TEXT READS: Roadmap\\".", "ignored": "x"}',
            encoding="utf-8",
        )
        output_file = tmp_path / "slide.png"

        fake_client = MagicMock()
        fake_client.images.generate.return_value = _make_response_with_b64(_fake_b64_image())
        with patch("openai.OpenAI", return_value=fake_client):
            script_module.generate_image(
                prompt_file=str(prompt_file),
                reference_images=[],
                output_file=str(output_file),
                aspect_ratio="16:9",
                slide_visual=True,
            )

        fake_client.images.generate.assert_called_once()
        kwargs = fake_client.images.generate.call_args.kwargs
        assert kwargs["size"] == "1536x864"
        assert kwargs["quality"] == "high"
        assert kwargs["prompt"].startswith('A professional slide. Title: "THE TEXT READS: Roadmap".')
        assert script_module._SOPHIA_SLIDE_STYLE in kwargs["prompt"]
        assert script_module._SOPHIA_SLIDE_AVOID in kwargs["prompt"]

    def test_slide_visual_passes_quality_to_edit_path(
        self, script_module, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

        prompt_file = tmp_path / "slide.json"
        prompt_file.write_text('{"prompt": "Slide two"}', encoding="utf-8")
        ref_file = tmp_path / "ref.png"
        ref_file.write_bytes(_real_png_bytes())
        output_file = tmp_path / "slide-two.png"

        fake_client = MagicMock()
        fake_client.images.edit.return_value = _make_response_with_b64(_fake_b64_image())
        with patch("openai.OpenAI", return_value=fake_client):
            script_module.generate_image(
                prompt_file=str(prompt_file),
                reference_images=[str(ref_file)],
                output_file=str(output_file),
                aspect_ratio="16:9",
                slide_visual=True,
            )

        kwargs = fake_client.images.edit.call_args.kwargs
        assert kwargs["size"] == "1536x1024"
        assert kwargs["quality"] == "high"


class TestApiFailuresExitNonZero:
    def test_api_exception_exits_1(
        self, script_module, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

        prompt_file = tmp_path / "prompt.json"
        prompt_file.write_text("anything", encoding="utf-8")
        output_file = tmp_path / "out.png"

        fake_client = MagicMock()
        fake_client.images.generate.side_effect = RuntimeError("rate limit")
        with patch("openai.OpenAI", return_value=fake_client):
            with pytest.raises(SystemExit) as excinfo:
                script_module.generate_image(
                    prompt_file=str(prompt_file),
                    reference_images=[],
                    output_file=str(output_file),
                    aspect_ratio="16:9",
                )
        assert excinfo.value.code == 1
        assert not output_file.exists()

    def test_response_without_b64_payload_exits_1(
        self, script_module, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

        prompt_file = tmp_path / "prompt.json"
        prompt_file.write_text("anything", encoding="utf-8")
        output_file = tmp_path / "out.png"

        fake_client = MagicMock()
        # Return a response with no usable payload — the script should
        # raise on the missing field, get caught by main(), and exit non-zero.
        fake_client.images.generate.return_value = _make_response_with_b64(None)
        with patch("openai.OpenAI", return_value=fake_client):
            with pytest.raises(SystemExit) as excinfo:
                script_module.generate_image(
                    prompt_file=str(prompt_file),
                    reference_images=[],
                    output_file=str(output_file),
                    aspect_ratio="16:9",
                )
        assert excinfo.value.code == 1
        assert not output_file.exists()

    @pytest.mark.parametrize(
        "message, expected",
        [
            ("Your organization must be verified to use this model", "org_not_verified"),
            ("Incorrect API key provided", "auth_invalid"),
            ("Request blocked by content policy", "content_blocked"),
            ("ReadTimeout: timed out", "timeout"),
            ("ConnectError: DNS failure", "egress_blocked"),
            ("Invalid size value", "invalid_size"),
            ("some other provider issue", "api_error"),
        ],
    )
    def test_classifies_openai_failures(self, script_module, message: str, expected: str) -> None:
        assert script_module._classify_exception(RuntimeError(message)) == expected


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _real_png_bytes() -> bytes:
    """Return bytes of a 1x1 valid PNG so PIL.Image.verify() succeeds."""
    from io import BytesIO

    from PIL import Image

    img = Image.new("RGB", (1, 1), color=(255, 0, 0))
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
