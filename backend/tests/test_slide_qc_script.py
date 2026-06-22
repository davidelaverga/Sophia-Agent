from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPT_PATH = _REPO_ROOT / "skills" / "public" / "image-generation" / "scripts" / "slide_qc.py"


@pytest.fixture
def qc_module():
    spec = importlib.util.spec_from_file_location("slide_qc_script", _SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_parse_review_accepts_json_only(qc_module) -> None:
    assert qc_module.parse_review('{"pass": true, "reasons": []}') == {"pass": True, "reasons": []}
    assert qc_module.parse_review('{"pass": false, "reasons": ["garbled text"]}') == {
        "pass": False,
        "reasons": ["garbled text"],
    }


def test_parse_review_fails_closed_on_bad_output(qc_module) -> None:
    payload = qc_module.parse_review("looks fine to me")
    assert payload["pass"] is False
    assert payload["reasons"] == ["QC reviewer returned non-JSON output"]


def test_emit_prints_trace_diagnostic_without_breaking_stdout_json(qc_module, capsys: pytest.CaptureFixture[str]) -> None:
    exit_code = qc_module._emit({"pass": False, "reasons": ["garbled title"]})

    captured = capsys.readouterr()
    assert exit_code == 1
    assert captured.out.strip() == '{"pass": false, "reasons": ["garbled title"]}'
    assert captured.err.strip() == '[qc] PASS=False reasons=["garbled title"]'


def test_review_slide_fails_closed_when_anthropic_key_is_unavailable(
    qc_module,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    image_file = tmp_path / "slide.png"
    image_file.write_bytes(b"fake-png")
    spec_file = tmp_path / "slide.txt"
    spec_file.write_text("Title: Roadmap", encoding="utf-8")

    payload = qc_module.review_slide(image_file=image_file, spec_file=spec_file)

    assert payload["pass"] is False
    assert payload["skipped"] is True
    assert payload["reasons"] == ["slide QC skipped: ANTHROPIC_API_KEY is not set"]


def test_emit_treats_qc_skip_as_clean_advisory(qc_module, capsys: pytest.CaptureFixture[str]) -> None:
    exit_code = qc_module._emit(
        {"pass": False, "skipped": True, "reasons": ["slide QC skipped: ANTHROPIC_API_KEY is not set"]}
    )

    captured = capsys.readouterr()
    assert exit_code == 0
    assert '"skipped": true' in captured.out
    assert captured.err.strip() == '[qc] PASS=False reasons=["slide QC skipped: ANTHROPIC_API_KEY is not set"]'


def test_review_slide_sends_spec_and_image_to_anthropic(qc_module, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setenv("SOPHIA_SLIDE_QC_MODEL", "claude-test-vision")

    image_file = tmp_path / "slide.png"
    image_file.write_bytes(b"fake-png")
    spec_file = tmp_path / "slide.txt"
    spec_file.write_text('Title: "THE TEXT READS: Roadmap"', encoding="utf-8")

    fake_client = MagicMock()
    fake_client.messages.create.return_value = SimpleNamespace(
        content=[SimpleNamespace(text='{"pass": true, "reasons": []}')]
    )

    class _Anthropic:
        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            pass

        @property
        def messages(self):
            return fake_client.messages

    monkeypatch.setitem(sys.modules, "anthropic", SimpleNamespace(Anthropic=_Anthropic))

    payload = qc_module.review_slide(image_file=image_file, spec_file=spec_file)

    assert payload == {"pass": True, "reasons": []}
    kwargs = fake_client.messages.create.call_args.kwargs
    assert kwargs["model"] == "claude-test-vision"
    assert kwargs["temperature"] == 0
    content = kwargs["messages"][0]["content"]
    assert content[0]["type"] == "text"
    assert "strict slide QC reviewer" in content[0]["text"]
    assert "Philosophy:" in content[0]["text"]
    assert "Hierarchy:" in content[0]["text"]
    assert "Specificity:" in content[0]["text"]
    assert 'Title: "THE TEXT READS: Roadmap"' in content[0]["text"]
    assert content[1]["type"] == "image"
    assert content[1]["source"]["type"] == "base64"
