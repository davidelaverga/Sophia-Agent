from __future__ import annotations

import importlib.util
import json
import shutil
from pathlib import Path

import pytest
from PIL import Image
from pptx import Presentation
from pptx.util import Inches

from deerflow.sophia.deck_native import DeckNativeService


def test_deck_native_preflight_reports_missing_scripts(tmp_path: Path) -> None:
    service = DeckNativeService(scripts_dir=tmp_path / "missing-scripts")

    result = service.preflight()

    assert result.success is False
    assert result.scripts_dir_exists is False
    assert result.deck_py_exists is False
    assert result.html2patch_py_exists is False
    assert "deck.py" in "\n".join(result.errors)


def _wide_base_deck(path: Path) -> None:
    presentation = Presentation()
    presentation.slide_width = Inches(20)
    presentation.slide_height = Inches(11.25)
    path.parent.mkdir(parents=True, exist_ok=True)
    presentation.save(path)


def _native_text_patch(path: Path, *, text: str = "Hello Native") -> None:
    path.write_text(
        json.dumps(
            {
                "ops": [
                    {"op": "add-slide", "layout": "Blank"},
                    {
                        "op": "add-shape",
                        "slide": 0,
                        "kind": "textbox",
                        "at": [1, 1],
                        "size": [8, 0.8],
                        "text": [text],
                        "name": "title",
                    },
                ]
            }
        ),
        encoding="utf-8",
    )


def test_deck_native_apply_inspect_render_and_diff(tmp_path: Path) -> None:
    if not shutil.which("soffice") or not shutil.which("pdftoppm"):
        pytest.skip("hands-on-deck render requires LibreOffice and Poppler")
    base = tmp_path / "base.pptx"
    patch = tmp_path / "patch.json"
    output = tmp_path / "out.pptx"
    render_dir = tmp_path / "rendered"
    _wide_base_deck(base)
    _native_text_patch(patch)
    service = DeckNativeService()

    applied = service.apply_patch(base_deck_path=str(base), patch_path=str(patch), output_path=str(output), fix=True)
    inspected = service.inspect(str(output))
    rendered = service.render(pptx_path=str(output), output_dir=str(render_dir), slides=[0])
    diff = service.diff(before_path=str(base), after_path=str(output))

    assert applied.success is True
    assert output.is_file()
    assert inspected.success is True
    assert inspected.native_text_shape_count > 0
    assert inspected.full_slide_picture_count == 0
    assert inspected.native_editability_score >= 0.60
    assert rendered.success is True
    assert rendered.rendered_slide_count == 1
    assert diff["success"] is True
    assert diff["changed"] is True


def test_deck_native_invalid_patch_fails_atomically(tmp_path: Path) -> None:
    base = tmp_path / "base.pptx"
    patch = tmp_path / "invalid.patch.json"
    output = tmp_path / "should-not-exist.pptx"
    _wide_base_deck(base)
    patch.write_text(
        json.dumps({"ops": [{"op": "add-shape", "slide": 99, "kind": "textbox", "at": [1, 1], "size": [1, 1], "text": ["bad"]}]}),
        encoding="utf-8",
    )

    result = DeckNativeService().apply_patch(base_deck_path=str(base), patch_path=str(patch), output_path=str(output))

    assert result.success is False
    assert result.validation_error_count >= 1
    assert not output.exists()


def test_deck_native_lint_fix_reports_residue(tmp_path: Path) -> None:
    base = tmp_path / "base.pptx"
    patch = tmp_path / "covered-text.patch.json"
    output = tmp_path / "covered-text.pptx"
    image = tmp_path / "cover.png"
    _wide_base_deck(base)
    Image.new("RGB", (100, 100), "red").save(image)
    patch.write_text(
        json.dumps(
            {
                "ops": [
                    {"op": "add-slide", "layout": "Blank"},
                    {"op": "add-shape", "slide": 0, "kind": "textbox", "at": [1, 1], "size": [5, 1], "text": ["Hidden text"]},
                    {"op": "add-picture", "slide": 0, "image": str(image), "at": [1, 1], "size": [5, 1]},
                ]
            }
        ),
        encoding="utf-8",
    )
    service = DeckNativeService()
    applied = service.apply_patch(base_deck_path=str(base), patch_path=str(patch), output_path=str(output), fix=False)

    fixed = service.lint_fix(pptx_path=str(output), touched_slides=[0])

    assert applied.success is True
    assert fixed.success is True
    assert fixed.residue_count == 1
    assert fixed.residue[0]["shape"].startswith("s")


def test_deck_native_html_to_patch_compiles_when_playwright_available(tmp_path: Path) -> None:
    if importlib.util.find_spec("playwright") is None:
        pytest.skip("Python Playwright is not installed in this backend env")
    base = tmp_path / "base.pptx"
    html = tmp_path / "slide.html"
    patch = tmp_path / "html.patch.json"
    output = tmp_path / "html-native.pptx"
    _wide_base_deck(base)
    html.write_text(
        """<!doctype html><html><body style="margin:0;width:1920px;height:1080px">
        <h1 style="position:absolute;left:96px;top:90px;font-size:72px">Native HTML</h1>
        <p style="position:absolute;left:96px;top:220px;font-size:36px">Compiled through html2patch.</p>
        </body></html>""",
        encoding="utf-8",
    )
    service = DeckNativeService()

    patched = service.html_to_patch(html_paths=[str(html)], base_deck_path=str(base), output_patch_path=str(patch))
    if not patched.success and any("browser" in error.lower() or "chromium" in error.lower() for error in patched.errors):
        pytest.skip("Python Playwright is installed but Chromium is unavailable")
    applied = service.apply_patch(base_deck_path=str(base), patch_path=str(patch), output_path=str(output), fix=True)
    inspected = service.inspect(str(output))

    assert patched.success is True
    assert patched.patch_op_count > 0
    assert applied.success is True
    assert inspected.native_text_shape_count >= 2
    assert inspected.full_slide_picture_count == 0
