"""Tests for ``skills/public/image-generation/scripts/generate.py``.

The script lives outside the ``backend/`` package so we load it via
``importlib`` rather than a normal import. Subprocess tests cover the
hard-fail-on-missing-key path that must work without any of our test
machinery (the bash tool will call the bare script in production).
"""

from __future__ import annotations

import base64
import hashlib
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

        # Per-call timeout (120s) + SDK retries (3) recover transient 429/5xx.
        openai_ctor.assert_called_once_with(api_key="sk-test", timeout=120.0, max_retries=3)
        fake_client.images.generate.assert_called_once_with(
            model="gpt-image-2",
            prompt=f"a clear blue sky\n\n{script_module._SOPHIA_IMAGE_STYLE}\n\n{script_module._SOPHIA_IMAGE_AVOID}",
            size="1536x1024",
        )
        fake_client.images.edit.assert_not_called()
        assert output_file.exists()
        assert output_file.stat().st_size > 0
        assert "IMAGEGEN_OK model=gpt-image-2" in result

    def test_langsmith_trace_records_sanitized_image_call(
        self, script_module, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        prompt = "create a precise launch slide"
        ref_file = tmp_path / "secret-reference-name.png"
        ref_file.write_bytes(_real_png_bytes())
        fake_client = MagicMock()
        fake_client.images.edit.return_value = _make_response_with_b64(_fake_b64_image())
        captured: dict[str, Any] = {}

        class FakeTraceContext:
            def __enter__(self) -> FakeTraceContext:
                return self

            def __exit__(self, *_exc: object) -> None:
                return None

            def end(self, *, outputs: dict[str, Any]) -> None:
                captured["outputs"] = outputs

        def fake_trace_context(**kwargs: Any) -> FakeTraceContext:
            captured["inputs"] = script_module._image_trace_inputs(**kwargs)
            return FakeTraceContext()

        monkeypatch.setattr(script_module, "_langsmith_trace_context", fake_trace_context)

        script_module._call_image_api_with_trace(
            fake_client,
            prompt=prompt,
            valid_refs=[str(ref_file)],
            size="1536x1024",
            quality="high",
        )

        assert captured["inputs"] == {
            "provider": "openai",
            "model": "gpt-image-2",
            "endpoint": "images.edit",
            "prompt": prompt,
            "prompt_truncated": False,
            "reference_image_count": 1,
            "reference_images": ["secret-reference-name.png"],
            "size": "1536x1024",
            "quality": "high",
        }
        assert captured["outputs"] == {
            "provider": "openai",
            "model": "gpt-image-2",
            "response_data_count": 1,
            "has_b64_payload": True,
        }
        fake_client.images.edit.assert_called_once()

    def test_langsmith_tracing_honors_builder_flag_without_global_autotracing(
        self, script_module, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        for name in (
            "LANGSMITH_TRACING",
            "LANGCHAIN_TRACING_V2",
            "LANGCHAIN_TRACING",
            "SOPHIA_BUILDER_LANGSMITH_TRACING",
            "LANGSMITH_API_KEY",
            "LANGCHAIN_API_KEY",
        ):
            monkeypatch.delenv(name, raising=False)

        monkeypatch.setenv("LANGSMITH_TRACING", "false")
        monkeypatch.setenv("SOPHIA_BUILDER_LANGSMITH_TRACING", "true")
        monkeypatch.setenv("LANGSMITH_API_KEY", "lsv2-test")

        assert script_module._langsmith_tracing_configured() is True

        monkeypatch.delenv("LANGSMITH_API_KEY", raising=False)
        assert script_module._langsmith_tracing_configured() is False

        monkeypatch.setenv("SOPHIA_BUILDER_LANGSMITH_TRACING", "false")
        monkeypatch.setenv("LANGSMITH_API_KEY", "lsv2-test")
        assert script_module._langsmith_tracing_configured() is False

        monkeypatch.setenv("LANGSMITH_TRACING", "true")
        assert script_module._langsmith_tracing_configured() is False

        monkeypatch.delenv("SOPHIA_BUILDER_LANGSMITH_TRACING", raising=False)
        assert script_module._langsmith_tracing_configured() is True

    def test_langsmith_trace_context_forces_enabled_context_when_global_tracing_false(
        self, script_module, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls: list[tuple[str, dict[str, Any]]] = []
        fake_client = object()
        monkeypatch.setattr(script_module, "_LANGSMITH_CLIENT", fake_client)
        monkeypatch.setenv("LANGSMITH_TRACING", "false")
        monkeypatch.setenv("SOPHIA_BUILDER_LANGSMITH_TRACING", "true")
        monkeypatch.setenv("LANGSMITH_PROJECT", '"Sophia"')
        monkeypatch.setenv("LANGSMITH_API_KEY", "lsv2-test")
        monkeypatch.setenv("SOPHIA_PARENT_TRACE_ID", "trace-1")
        monkeypatch.setenv("SOPHIA_PARENT_RUN_ID", "run-1")
        monkeypatch.setenv("SOPHIA_THREAD_ID", "thread-1")

        class FakeEnabledContext:
            def __enter__(self):
                calls.append(("enabled_enter", {}))

            def __exit__(self, *_exc: object) -> None:
                calls.append(("enabled_exit", {}))

        class FakeTraceContext:
            def __enter__(self):
                calls.append(("trace_enter", {}))
                return SimpleNamespace(end=lambda **kwargs: calls.append(("trace_end", kwargs)))

            def __exit__(self, *_exc: object) -> None:
                calls.append(("trace_exit", {}))

        def fake_tracing_context(**kwargs: Any):
            calls.append(("tracing_context", kwargs))
            return FakeEnabledContext()

        def fake_trace(*args: Any, **kwargs: Any):
            calls.append(("trace", {"args": args, **kwargs}))
            return FakeTraceContext()

        monkeypatch.setitem(
            sys.modules,
            "langsmith",
            SimpleNamespace(tracing_context=fake_tracing_context, trace=fake_trace),
        )

        trace_context = script_module._langsmith_trace_context(
            prompt="Slide prompt",
            valid_refs=[],
            size="1536x1024",
            quality="high",
        )

        assert trace_context is not None
        tracing_call = next(payload for name, payload in calls if name == "tracing_context")
        assert tracing_call["enabled"] is True
        assert tracing_call["client"] is fake_client
        assert tracing_call["project_name"] == "Sophia"
        assert tracing_call["metadata"] == {
            "sophia_component": "builder_image_generation",
            "parent_trace_id": "trace-1",
            "parent_run_id": "run-1",
            "thread_id": "thread-1",
        }
        trace_call = next(payload for name, payload in calls if name == "trace")
        assert trace_call["project_name"] == "Sophia"
        assert trace_call["metadata"]["parent_trace_id"] == "trace-1"
        assert trace_call["metadata"]["parent_run_id"] == "run-1"
        assert trace_call["metadata"]["thread_id"] == "thread-1"

        with trace_context as run:
            run.end(outputs={"ok": True})

        assert [name for name, _payload in calls if name.endswith("_enter")] == ["enabled_enter", "trace_enter"]


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
            result = script_module.generate_image(
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
        assert "IMAGEGEN_OK model=gpt-image-2" in result
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

    def test_invalid_reference_image_exits_before_openai_call(
        self, script_module, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

        prompt_file = tmp_path / "prompt.json"
        prompt_file.write_text("compose this", encoding="utf-8")
        invalid_ref = tmp_path / "broken.png"
        invalid_ref.write_text("not an image", encoding="utf-8")
        output_file = tmp_path / "out.png"

        fake_client = MagicMock()
        with patch("openai.OpenAI", return_value=fake_client):
            with pytest.raises(SystemExit) as excinfo:
                script_module.generate_image(
                    prompt_file=str(prompt_file),
                    reference_images=[str(invalid_ref)],
                    output_file=str(output_file),
                    aspect_ratio="16:9",
                )

        assert excinfo.value.code == 2
        assert not fake_client.images.generate.called
        assert not fake_client.images.edit.called
        assert not output_file.exists()
        stderr = capsys.readouterr().err
        assert "IMAGEGEN_FAIL reason=invalid_reference_image" in stderr
        assert "broken.png" in stderr


class TestSlideVisualMode:
    def test_slide_visual_generation_size_uses_supported_openai_size(self, script_module) -> None:
        assert (
            script_module._resolve_request_size(
                explicit_size=None,
                slide_visual=True,
                aspect_ratio="16:9",
                has_references=False,
            )
            == "1536x1024"
        )

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
        self, script_module, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

        prompt_file = tmp_path / "slide.json"
        prompt_file.write_text(
            '{"prompt": "A professional slide. Title: \\"THE TEXT READS: Roadmap\\".", "ignored": "x"}',
            encoding="utf-8",
        )
        output_file = tmp_path / "slide.png"

        fake_client = MagicMock()
        fake_client.images.generate.return_value = _make_response_with_b64(_real_png_b64(width=160, height=100))
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
        assert kwargs["size"] == "1536x1024"
        assert kwargs["quality"] == "high"
        assert kwargs["prompt"].startswith('A professional slide. Title: "THE TEXT READS: Roadmap".')
        assert script_module._SOPHIA_SLIDE_STYLE in kwargs["prompt"]
        assert script_module._SOPHIA_SLIDE_AVOID in kwargs["prompt"]
        assert "Do not bake the slide title" in kwargs["prompt"]
        assert "real HTML text" in kwargs["prompt"]
        assert "top 14%" not in kwargs["prompt"]
        assert "bottom 16%" not in kwargs["prompt"]
        captured = capsys.readouterr()
        assert "[gen] slide_visual=True quality=high size=1536x1024" in captured.out
        prompt_hash = hashlib.sha256(kwargs["prompt"].encode("utf-8")).hexdigest()[:16]
        assert f"[gen] PROMPT_SENT: sha256={prompt_hash} chars={len(kwargs['prompt'])}" in captured.out
        assert "THE TEXT READS: Roadmap" not in captured.out
        assert "[gen] result: ext=.png bytes=" in captured.out
        assert "ref_images=0" in captured.out
        with script_module.Image.open(output_file) as img:
            assert img.size == (178, 100)

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
        fake_client.images.edit.return_value = _make_response_with_b64(_real_png_b64(width=160, height=100))
        with patch("openai.OpenAI", return_value=fake_client):
            script_module.generate_image(
                prompt_file=str(prompt_file),
                reference_images=[str(ref_file)],
                output_file=str(output_file),
                aspect_ratio="16:9",
                slide_visual=True,
            )

        kwargs = fake_client.images.edit.call_args.kwargs
        assert kwargs["model"] == "gpt-image-2"
        assert kwargs["size"] == "1536x1024"
        assert kwargs["quality"] == "high"
        with script_module.Image.open(output_file) as img:
            assert img.size == (178, 100)

    def test_slide_visual_normalization_pads_instead_of_cropping(
        self,
        script_module,
        tmp_path: Path,
    ) -> None:
        output_file = tmp_path / "slide.png"
        image = script_module.Image.new("RGB", (160, 100), (255, 255, 255))
        image.putpixel((0, 0), (255, 0, 0))
        image.putpixel((159, 99), (0, 0, 255))
        image.save(output_file)

        script_module._normalize_slide_visual_aspect(str(output_file))

        with script_module.Image.open(output_file) as normalized:
            assert normalized.size == (178, 100)
            assert normalized.getpixel((9, 0)) == (255, 0, 0)
            assert normalized.getpixel((168, 99)) == (0, 0, 255)


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


def _real_png_bytes(*, width: int = 1, height: int = 1) -> bytes:
    """Return bytes of a 1x1 valid PNG so PIL.Image.verify() succeeds."""
    from io import BytesIO

    from PIL import Image

    img = Image.new("RGB", (width, height), color=(255, 0, 0))
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _real_png_b64(*, width: int = 1, height: int = 1) -> str:
    return base64.b64encode(_real_png_bytes(width=width, height=height)).decode("ascii")
