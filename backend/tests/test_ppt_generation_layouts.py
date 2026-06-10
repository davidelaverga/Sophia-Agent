"""Tests for ``skills/public/ppt-generation/scripts/generate.py`` layout dispatch and themes.

The script lives outside the ``backend/`` package so we load it via
``importlib`` rather than a normal import. One subprocess test guards the
stdout/stderr diagnostics contract that ``BuilderArtifactMiddleware`` parses.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from PIL import Image
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE
from pptx.util import Inches

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPT_PATH = _REPO_ROOT / "skills" / "public" / "ppt-generation" / "scripts" / "generate.py"

_REQUIRED_OFFICE_ENTRIES = {"[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml"}
_ALL_LAYOUTS = {
    "title",
    "content_text",
    "content_image",
    "full_bleed_image",
    "section_divider",
    "quote",
    "two_column",
    "closing",
}


def _load_module():
    spec = importlib.util.spec_from_file_location("ppt_generation_layouts_script", _SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


gen = _load_module()


def _write_png(path: Path, size=(320, 180)) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, color=(40, 140, 180)).save(path)
    return path


# ---------------------------------------------------------------------------
# resolve_layout
# ---------------------------------------------------------------------------


class TestResolveLayout:
    def test_explicit_valid_layout_wins(self) -> None:
        assert gen.resolve_layout({"layout": "quote", "type": "title"}, None) == "quote"

    def test_explicit_layout_is_normalized(self) -> None:
        assert gen.resolve_layout({"layout": "  Two_Column "}, None) == "two_column"

    def test_unknown_explicit_layout_warns_and_infers(self, capsys) -> None:
        assert gen.resolve_layout({"layout": "fancy"}, "/tmp/x.png") == "content_image"
        assert "Unknown layout 'fancy'" in capsys.readouterr().err

    def test_title_type_resolves_title(self) -> None:
        assert gen.resolve_layout({"type": "title", "title": "Deck"}, None) == "title"

    def test_image_resolves_content_image(self) -> None:
        assert gen.resolve_layout({"title": "Chart"}, "/tmp/chart.png") == "content_image"

    def test_no_image_resolves_content_text(self) -> None:
        assert gen.resolve_layout({"title": "Plain"}, None) == "content_text"

    def test_dispatch_table_covers_all_layouts(self) -> None:
        assert set(gen.LAYOUT_DISPATCH) == _ALL_LAYOUTS


# ---------------------------------------------------------------------------
# slide_theme
# ---------------------------------------------------------------------------


class TestSlideTheme:
    @pytest.mark.parametrize(
        "style, expected",
        [
            ("dark-premium", "boardroom"),
            ("keynote", "boardroom"),
            ("glassmorphism", "boardroom"),
            ("business", "daylight"),
            ("minimal", "mist"),
            ("academic", "mist"),
            ("creative", "ember"),
        ],
    )
    def test_legacy_style_aliases(self, style: str, expected: str) -> None:
        assert gen.slide_theme({"style": style}) is gen.THEMES[expected]

    @pytest.mark.parametrize("name", ["boardroom", "daylight", "ember", "mist"])
    def test_direct_theme_names(self, name: str) -> None:
        assert gen.slide_theme({"theme": name}) is gen.THEMES[name]

    def test_theme_key_takes_precedence_over_style(self) -> None:
        assert gen.slide_theme({"theme": "ember", "style": "dark-premium"}) is gen.THEMES["ember"]

    def test_theme_lookup_is_case_insensitive(self) -> None:
        assert gen.slide_theme({"theme": " Boardroom "}) is gen.THEMES["boardroom"]

    def test_missing_and_unknown_keys_default_to_daylight(self) -> None:
        assert gen.slide_theme({}) is gen.THEMES["daylight"]
        assert gen.slide_theme({"style": "gradient-modern"}) is gen.THEMES["daylight"]

    def test_every_theme_has_required_keys(self) -> None:
        required = {"background", "title", "body", "accent", "card", "border", "accent_deep", "overlay", "overlay_text", "title_font", "body_font"}
        for name, theme in gen.THEMES.items():
            assert required.issubset(theme), f"theme {name} missing {required - set(theme)}"
            assert theme["title_font"] in {"Georgia", "Calibri", "Arial"}
            assert theme["body_font"] in {"Georgia", "Calibri", "Arial"}


# ---------------------------------------------------------------------------
# set_fill_transparency / fitted_image_cover_payload
# ---------------------------------------------------------------------------


class TestVisualHelpers:
    def test_set_fill_transparency_injects_alpha(self) -> None:
        prs = Presentation()
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, Inches(1), Inches(1))
        shape.fill.solid()
        shape.fill.fore_color.rgb = gen.THEMES["boardroom"]["overlay"]

        gen.set_fill_transparency(shape, 40)

        xml = shape._element.xml
        assert "<a:alpha" in xml
        assert 'val="40000"' in xml

    def test_set_fill_transparency_is_idempotent(self) -> None:
        prs = Presentation()
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, Inches(1), Inches(1))
        shape.fill.solid()
        shape.fill.fore_color.rgb = gen.THEMES["daylight"]["overlay"]

        gen.set_fill_transparency(shape, 40)
        gen.set_fill_transparency(shape, 40)

        assert shape._element.xml.count("<a:alpha") == 1

    def test_cover_payload_center_crops_to_16_9_pixels(self) -> None:
        img = Image.new("RGB", (300, 500), color=(10, 20, 30))
        payload = gen.fitted_image_cover_payload(img, Inches(13.333), Inches(7.5))
        with Image.open(payload) as out:
            assert out.format == "JPEG"
            assert out.size == (1280, 720)

    def test_cover_payload_center_crops_to_4_3_pixels(self) -> None:
        img = Image.new("RGB", (900, 300), color=(10, 20, 30))
        payload = gen.fitted_image_cover_payload(img, Inches(10), Inches(7.5))
        with Image.open(payload) as out:
            assert out.size == (1280, 960)


# ---------------------------------------------------------------------------
# End-to-end generate_ppt
# ---------------------------------------------------------------------------


class TestGeneratePptLayouts:
    def test_every_layout_renders_in_one_deck(self, tmp_path: Path) -> None:
        png = _write_png(tmp_path / "visuals" / "chart.png")
        plan = {
            "title": "Sophia Roadmap",
            "theme": "boardroom",
            "aspect_ratio": "16:9",
            "slides": [
                {"slide_number": 1, "layout": "title", "title": "Sophia Roadmap", "subtitle": "H2 2026", "image": str(png)},
                {"slide_number": 2, "layout": "content_text", "title": "Context", "key_points": ["Where we are", "Where we go"]},
                {"slide_number": 3, "layout": "content_image", "title": "Architecture", "key_points": ["Capture", "Plan"], "image": str(png)},
                {"slide_number": 4, "layout": "full_bleed_image", "title": "The Vision", "subtitle": "One intelligence layer", "image": str(png)},
                {"slide_number": 5, "layout": "section_divider", "title": "Part Two", "section_number": 2},
                {"slide_number": 6, "layout": "quote", "quote": "She remembers, notices, and sometimes surprises.", "attribution": "Spec v7.0"},
                {"slide_number": 7, "layout": "two_column", "title": "Tradeoffs", "columns": [{"heading": "Pros", "points": ["Fast", "Cheap"]}, {"heading": "Cons", "points": ["Risky"]}]},
                {"slide_number": 8, "layout": "closing", "subtitle": "sophia-ei.com"},
            ],
        }
        plan_file = tmp_path / "plan.json"
        plan_file.write_text(json.dumps(plan), encoding="utf-8")
        output = tmp_path / "deck.pptx"

        message = gen.generate_ppt(str(plan_file), [], str(output))

        assert message == "Successfully generated presentation with 8 slides (picture_count=3)"
        prs = Presentation(str(output))
        assert len(prs.slides) == 8
        with zipfile.ZipFile(output) as archive:
            names = set(archive.namelist())
            assert _REQUIRED_OFFICE_ENTRIES.issubset(names)
            # 3 picture shapes, but python-pptx dedupes identical image bytes into one
            # media part (title + full_bleed share the same cover JPEG payload).
            assert sum(1 for name in names if name.startswith("ppt/media/")) >= 2

    def test_missing_full_bleed_image_degrades_without_exception(self, tmp_path: Path, capsys) -> None:
        plan = {
            "title": "Deck",
            "slides": [{"slide_number": 1, "layout": "full_bleed_image", "title": "Vision", "image": str(tmp_path / "missing.png")}],
        }
        plan_file = tmp_path / "plan.json"
        plan_file.write_text(json.dumps(plan), encoding="utf-8")
        output = tmp_path / "deck.pptx"

        message = gen.generate_ppt(str(plan_file), [], str(output))

        assert message == "Successfully generated presentation with 1 slides (picture_count=0)"
        assert "Slide image missing, using text layout:" in capsys.readouterr().err
        assert output.exists()

    def test_explicit_image_layout_without_image_ref_degrades(self, tmp_path: Path) -> None:
        plan = {"slides": [{"slide_number": 1, "layout": "content_image", "title": "No Image", "key_points": ["a"]}]}
        plan_file = tmp_path / "plan.json"
        plan_file.write_text(json.dumps(plan), encoding="utf-8")
        output = tmp_path / "deck.pptx"

        message = gen.generate_ppt(str(plan_file), [], str(output))

        assert message == "Successfully generated presentation with 1 slides (picture_count=0)"

    def test_backward_compat_plan_without_layout_or_theme_keys(self, tmp_path: Path) -> None:
        png = _write_png(tmp_path / "outputs" / "visuals" / "chart.png")
        slides = [
            {"slide_number": 1, "type": "title", "title": "Deck", "subtitle": "Tagline"},
            {"slide_number": 2, "type": "content", "title": "Data", "key_points": ["a", "b"], "chart_path": str(png)},
            {"slide_number": 3, "type": "content", "title": "Words", "key_points": ["c"]},
        ]
        plan = {"title": "Deck", "style": "dark-premium", "aspect_ratio": "16:9", "slides": slides}
        plan_file = tmp_path / "plan.json"
        plan_file.write_text(json.dumps(plan), encoding="utf-8")
        output = tmp_path / "deck.pptx"

        # Same resolution choices as the pre-dispatch script: title type gets the
        # title treatment, an image ref gets content_image, the rest content_text.
        assert gen.resolve_layout(slides[0], None) == "title"
        assert gen.resolve_layout(slides[1], str(png)) == "content_image"
        assert gen.resolve_layout(slides[2], None) == "content_text"

        message = gen.generate_ppt(str(plan_file), [], str(output))

        assert message == "Successfully generated presentation with 3 slides (picture_count=1)"
        # Legacy dark styles keep resolving to a dark theme.
        assert gen.slide_theme(plan) is gen.THEMES["boardroom"]

    def test_cli_diagnostics_contract_is_unchanged(self, tmp_path: Path) -> None:
        plan = {
            "title": "Contract",
            "theme": "ember",
            "slides": [
                {"slide_number": 1, "layout": "section_divider", "title": "Part One"},
                {"slide_number": 2, "layout": "content_text", "title": "Body", "key_points": ["a"]},
            ],
        }
        plan_file = tmp_path / "plan.json"
        plan_file.write_text(json.dumps(plan), encoding="utf-8")
        output = tmp_path / "deck.pptx"

        result = subprocess.run(
            [sys.executable, str(_SCRIPT_PATH), "--plan-file", str(plan_file), "--output-file", str(output)],
            capture_output=True,
            text=True,
            timeout=30,
        )

        assert result.returncode == 0, result.stderr
        assert "Successfully generated presentation with 2 slides (picture_count=0)" in result.stdout
        assert "PPT generation diagnostics:" in result.stderr
        assert "picture_count=0" in result.stderr
        assert "output_ext=.pptx" in result.stderr
