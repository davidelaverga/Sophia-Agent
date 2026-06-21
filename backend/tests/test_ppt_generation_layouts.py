"""Tests for ``skills/public/ppt-generation/scripts/generate.py`` layout dispatch and themes.

The script lives outside the ``backend/`` package so we load it via
``importlib`` rather than a normal import. One subprocess test guards the
stdout/stderr diagnostics contract that ``BuilderArtifactMiddleware`` parses.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from PIL import Image
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE
from pptx.util import Inches, Pt

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPT_PATH = _REPO_ROOT / "skills" / "public" / "ppt-generation" / "scripts" / "generate.py"
_JS_COMPILER_PATH = _REPO_ROOT / "backend" / "packages" / "harness" / "deerflow" / "sophia" / "js" / "compile_pptx.mjs"
_CODEX_NODE_BIN = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
_CODEX_NODE_MODULES = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules"

_REQUIRED_OFFICE_ENTRIES = {"[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml"}
_ALL_LAYOUTS = {
    "title",
    "content_text",
    "content_image",
    "image_forward",
    "full_bleed_image",
    "section_divider",
    "quote",
    "two_column",
    "closing",
    "stat_band",
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


def _blank_slide():
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    return prs, prs.slides.add_slide(prs.slide_layouts[6])


def _slide_paragraphs(slide):
    for shape in slide.shapes:
        if shape.has_text_frame:
            yield from shape.text_frame.paragraphs


def _slide_texts(slide) -> list[str]:
    return [paragraph.text for paragraph in _slide_paragraphs(slide)]


def _pptxgenjs_runtime(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    node_modules_candidates = [
        _JS_COMPILER_PATH.parent / "node_modules",
        _CODEX_NODE_MODULES,
    ]
    node_modules = next(
        (path for path in node_modules_candidates if (path / "pptxgenjs" / "package.json").is_file()),
        None,
    )
    if node_modules is None:
        pytest.skip("pptxgenjs is not installed for local JS compiler tests")
    runtime_dir = tmp_path / "pptxgenjs-runtime"
    runtime_dir.mkdir()
    shutil.copy2(_JS_COMPILER_PATH, runtime_dir / "compile_pptx.mjs")
    os.symlink(node_modules, runtime_dir / "node_modules", target_is_directory=True)
    if _CODEX_NODE_BIN.is_file():
        monkeypatch.setenv("PATH", f"{_CODEX_NODE_BIN.parent}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setenv("SOPHIA_PPTXGENJS", "1")
    monkeypatch.setenv("SOPHIA_ARTIFACT_JS_RUNTIME", str(runtime_dir))
    return runtime_dir


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

    def test_image_path_resolves_image_forward(self) -> None:
        assert gen.resolve_layout({"title": "Generated", "image_path": "/tmp/slide.png"}, "/tmp/slide.png") == "image_forward"

    def test_cli_image_resolves_image_forward(self) -> None:
        assert gen.resolve_layout({"title": "Generated"}, "/tmp/slide.png", cli_image=True) == "image_forward"

    def test_visual_path_resolves_content_image(self) -> None:
        assert gen.resolve_layout({"title": "Chart", "visual_path": "/tmp/chart.png"}, "/tmp/chart.png") == "content_image"

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

    def test_js_compiler_is_brand_design_system_engine(self) -> None:
        # Artifact Visual System Phase 3a: the engine is now the brand
        # design system — Cambria/Calibri, sophia_* token themes, the five
        # slide renderers (incl. the new stat + full-visual layouts), and a
        # back-compat type/subtype mapping so older plans still render.
        source = _JS_COMPILER_PATH.read_text(encoding="utf-8")

        assert 'const FONT_HEAD = "Cambria"' in source
        assert 'const FONT_BODY = "Calibri"' in source
        assert "sophia_light" in source
        assert "function slideType" in source       # legacy type → new type
        assert "function contentSubtype" in source   # subtype dispatch (two-column etc.)
        assert "function renderCover" in source
        assert "function renderStat" in source       # new stat callout
        assert "function renderFullVisual" in source  # new full-visual layout
        assert "function renderTwoColumn" in source   # two-column layout
        assert "function renderStatement" in source
        assert "function renderImageForward" in source
        assert "function addFullBleedVisual" in source
        assert "function fullBleedImageSizing" in source
        assert 'return { type: "cover", x: 0, y: 0, w: SLIDE_W, h: SLIDE_H };' in source
        assert "sizing: fullBleedImageSizing()" in source
        assert "function usablePlanVisualPath" in source
        assert "Slide image missing, using text layout:" in source
        assert "if (!imageForward)" in source
        assert 'valign: "middle"' in source
        assert '"boardroom":' not in source
        assert '"daylight":' not in source
        assert '"ember":' not in source

    def test_js_compiler_treats_cli_slide_images_as_image_forward(self) -> None:
        source = _JS_COMPILER_PATH.read_text(encoding="utf-8")

        assert "const cliImageForward = Boolean(cliImagePath && visualPath);" in source
        assert (
            "let imageForward = Boolean(visualPath && (cliImageForward || isImageForwardSlide(slideInfo)));" in source
        )
        assert "renderImageForward(pptx, visualPath, slideInfo, plan, theme, index)" in source
        assert "if (imageForward && visualPath)" in source

    def test_js_compiler_treats_legacy_full_bleed_image_refs_as_image_forward(self) -> None:
        source = _JS_COMPILER_PATH.read_text(encoding="utf-8")

        assert "const hasImagePath = typeof slideInfo.image_path === \"string\" && slideInfo.image_path.trim();" in source
        assert "const hasLegacyFullBleedImage =" in source
        assert "typeof slideInfo.image === \"string\"" in source
        assert "normalizeLayout(slideInfo.layout) === \"full_bleed_image\"" in source
        assert "return Boolean(hasImagePath || hasLegacyFullBleedImage);" in source

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

    def test_missing_image_forward_cli_image_degrades_to_editable_text(self, tmp_path: Path, capsys) -> None:
        plan = {
            "title": "Deck",
            "slides": [
                {
                    "slide_number": 1,
                    "title": "Generated full-slide",
                    "key_points": ["Fallback keeps the deck editable"],
                    "image_path": "/mnt/user-data/outputs/slides/missing.png",
                }
            ],
        }
        plan_file = tmp_path / "plan.json"
        plan_file.write_text(json.dumps(plan), encoding="utf-8")
        output = tmp_path / "deck.pptx"

        message = gen.generate_ppt(str(plan_file), [str(tmp_path / "also-missing.png")], str(output))

        assert message == "Successfully generated presentation with 1 slides (picture_count=0)"
        assert "Slide image missing, using text layout:" in capsys.readouterr().err
        prs = Presentation(str(output))
        texts = " ".join(_slide_texts(prs.slides[0]))
        assert "Generated full-slide" in texts
        assert "Fallback keeps the deck editable" in texts

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

    def test_slide_images_get_native_title_overlay_when_not_qc_confirmed(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        _pptxgenjs_runtime(tmp_path, monkeypatch)
        hero = _write_png(tmp_path / "hero.png")
        plan = {
            "title": "Open Claw",
            "theme": "boardroom",
            "slides": [
                {
                    "slide_number": 1,
                    "layout": "title",
                    "title": "Open Claw Assistant",
                    "subtitle": "A safer operator workflow",
                },
                {
                    "slide_number": 2,
                    "layout": "content_image",
                    "title": "Runtime Loop",
                    "key_points": ["Observe", "Plan", "Act", "Verify"],
                },
            ],
        }
        plan_file = tmp_path / "plan.json"
        plan_file.write_text(json.dumps(plan), encoding="utf-8")
        output = tmp_path / "deck.pptx"

        message = gen.generate_ppt(str(plan_file), [str(hero), str(hero)], str(output))

        assert message == "Successfully generated presentation with PptxGenJS"
        prs = Presentation(str(output))
        assert "Open Claw Assistant" in _slide_texts(prs.slides[0])
        assert "Runtime Loop" in _slide_texts(prs.slides[1])

    def test_image_path_can_mark_bitmap_title_qc_confirmed_to_skip_overlay(self, tmp_path: Path) -> None:
        hero = _write_png(tmp_path / "slide.png")
        plan = {
            "title": "Image Forward",
            "slides": [
                {
                    "slide_number": 1,
                    "title": "Generated full-slide",
                    "key_points": ["Already rendered inside the image"],
                    "image_path": str(hero),
                    "title_in_image_qc_confirmed": True,
                }
            ],
        }
        plan_file = tmp_path / "plan.json"
        plan_file.write_text(json.dumps(plan), encoding="utf-8")
        output = tmp_path / "deck.pptx"

        message = gen.generate_ppt(str(plan_file), [], str(output))

        assert message == "Successfully generated presentation with 1 slides (picture_count=1)"
        prs = Presentation(str(output))
        assert _slide_texts(prs.slides[0]) == []

    def test_python_image_forward_adds_native_title_when_not_qc_confirmed(self, tmp_path: Path) -> None:
        hero = _write_png(tmp_path / "slide.png")
        plan = {
            "title": "Image Forward",
            "slides": [
                {
                    "slide_number": 1,
                    "title": "Generated full-slide",
                    "subtitle": "Native title overlay",
                    "image_path": str(hero),
                }
            ],
        }
        plan_file = tmp_path / "plan.json"
        plan_file.write_text(json.dumps(plan), encoding="utf-8")
        output = tmp_path / "deck.pptx"

        message = gen.generate_ppt(str(plan_file), [], str(output))

        assert message == "Successfully generated presentation with 1 slides (picture_count=1)"
        prs = Presentation(str(output))
        assert "Generated full-slide" in _slide_texts(prs.slides[0])
        assert "Native title overlay" in _slide_texts(prs.slides[0])

    def test_image_forward_compiler_logs_title_presence_diagnostics(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        runtime_dir = _pptxgenjs_runtime(tmp_path, monkeypatch)
        hero = _write_png(tmp_path / "slide.png")
        plan = {"title": "Deck", "slides": [{"slide_number": 1, "title": "Visible Title", "image_path": str(hero)}]}
        plan_file = tmp_path / "plan.json"
        plan_file.write_text(json.dumps(plan), encoding="utf-8")
        output = tmp_path / "deck.pptx"

        result = subprocess.run(
            [
                shutil.which("node") or "node",
                str(runtime_dir / "compile_pptx.mjs"),
                "--plan-file",
                str(plan_file),
                "--output-file",
                str(output),
            ],
            capture_output=True,
            text=True,
            timeout=20,
        )

        assert result.returncode == 0, result.stderr
        assert "PPTXGEN slide_diagnostics: slide=1" in result.stderr
        assert "image_forward=true" in result.stderr
        assert "title_present=true" in result.stderr
        assert "title_overlay=true" in result.stderr

    def test_image_forward_title_strategy_baked_without_qc_keeps_overlay(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        runtime_dir = _pptxgenjs_runtime(tmp_path, monkeypatch)
        hero = _write_png(tmp_path / "slide.png")
        plan = {
            "title": "Deck",
            "slides": [
                {
                    "slide_number": 1,
                    "title": "Visible Title",
                    "image_path": str(hero),
                    "title_strategy": "baked",
                }
            ],
        }
        plan_file = tmp_path / "plan.json"
        plan_file.write_text(json.dumps(plan), encoding="utf-8")
        output = tmp_path / "deck.pptx"

        result = subprocess.run(
            [
                shutil.which("node") or "node",
                str(runtime_dir / "compile_pptx.mjs"),
                "--plan-file",
                str(plan_file),
                "--output-file",
                str(output),
            ],
            capture_output=True,
            text=True,
            timeout=20,
        )

        assert result.returncode == 0, result.stderr
        assert "title_present=true" in result.stderr
        assert "title_overlay=true" in result.stderr
        assert "Visible Title" in _slide_texts(Presentation(str(output)).slides[0])

    def test_image_forward_title_baked_qc_confirmed_suppresses_overlay(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        runtime_dir = _pptxgenjs_runtime(tmp_path, monkeypatch)
        hero = _write_png(tmp_path / "slide.png")
        plan = {
            "title": "Deck",
            "slides": [
                {
                    "slide_number": 1,
                    "title": "Visible Title",
                    "image_path": str(hero),
                    "title_strategy": "baked",
                    "title_baked_qc_confirmed": True,
                }
            ],
        }
        plan_file = tmp_path / "plan.json"
        plan_file.write_text(json.dumps(plan), encoding="utf-8")
        output = tmp_path / "deck.pptx"

        result = subprocess.run(
            [
                shutil.which("node") or "node",
                str(runtime_dir / "compile_pptx.mjs"),
                "--plan-file",
                str(plan_file),
                "--output-file",
                str(output),
            ],
            capture_output=True,
            text=True,
            timeout=20,
        )

        assert result.returncode == 0, result.stderr
        assert "title_present=true" in result.stderr
        assert "title_overlay=false" in result.stderr
        assert _slide_texts(Presentation(str(output)).slides[0]) == []

    def test_design_language_deck_terra_and_noir(self, tmp_path: Path) -> None:
        png = _write_png(tmp_path / "visuals" / "chart.png")
        for theme_name in ("terra", "noir"):
            plan = {
                "title": "Design Language",
                "theme": theme_name,
                "motif": "dot_grid",
                "aspect_ratio": "16:9",
                "slides": [
                    {"slide_number": 1, "layout": "title", "title": "Design Language", "subtitle": "VQ-8"},
                    {"slide_number": 2, "layout": "stat_band", "title": "By The Numbers", "stats": [{"value": "87%", "label": "adoption"}, {"value": "3x", "label": "throughput"}, {"value": "12", "label": "markets"}]},
                    {"slide_number": 3, "layout": "content_image", "title": "Architecture", "key_points": ["Capture", "Plan"], "image": str(png)},
                    {"slide_number": 4, "layout": "quote", "quote": "Repetition builds identity.", "attribution": "Composio"},
                    {"slide_number": 5, "layout": "full_bleed_image", "title": "The Vision", "image": str(png)},
                    {"slide_number": 6, "layout": "closing", "subtitle": "sophia-ei.com"},
                ],
            }
            plan_file = tmp_path / f"plan-{theme_name}.json"
            plan_file.write_text(json.dumps(plan), encoding="utf-8")
            output = tmp_path / f"deck-{theme_name}.pptx"

            message = gen.generate_ppt(str(plan_file), [], str(output))

            assert message == "Successfully generated presentation with 6 slides (picture_count=2)"
            with zipfile.ZipFile(output) as archive:
                names = set(archive.namelist())
                assert _REQUIRED_OFFICE_ENTRIES.issubset(names)
                assert any(name.startswith("ppt/media/") for name in names)
            prs = Presentation(str(output))
            assert len(prs.slides) == 6
            # stat_band slide carries oversized accent values + a dot_grid motif (9 dots).
            stat_slide = prs.slides[1]
            texts = _slide_texts(stat_slide)
            assert "87%" in texts and "adoption" in texts
            dots = [shape for shape in stat_slide.shapes if shape.width == Pt(4) and shape.height == Pt(4)]
            assert len(dots) == 9

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


# ---------------------------------------------------------------------------
# New themes (terra / noir) + palette discipline
# ---------------------------------------------------------------------------


class TestDesignLanguageThemes:
    def test_theme_registry_has_six_themes(self) -> None:
        assert set(gen.THEMES) == {"boardroom", "daylight", "ember", "mist", "terra", "noir"}

    def test_terra_palette_anchors(self) -> None:
        terra = gen.THEMES["terra"]
        assert str(terra["background"]) == "F4F1DE"
        assert str(terra["title"]) == "2C2C2C"
        assert str(terra["accent"]) == "87A96B"
        assert str(terra["accent_deep"]) == "E07A5F"

    def test_noir_palette_anchors(self) -> None:
        noir = gen.THEMES["noir"]
        assert str(noir["background"]) == "111111"
        assert str(noir["title"]) == "F4F6F6"
        assert str(noir["accent"]) == "BF9A4A"
        assert str(noir["accent_deep"]) == "000000"

    @pytest.mark.parametrize(
        "style, expected",
        [
            ("earthy", "terra"),
            ("organic", "terra"),
            ("luxury", "noir"),
            ("premium-dark", "noir"),
        ],
    )
    def test_new_style_aliases(self, style: str, expected: str) -> None:
        assert gen.slide_theme({"style": style}) is gen.THEMES[expected]

    def test_every_alias_targets_a_known_theme(self) -> None:
        for alias, target in gen._STYLE_ALIASES.items():
            assert target in gen.THEMES, f"alias {alias} points at unknown theme {target}"


# ---------------------------------------------------------------------------
# apply_motif
# ---------------------------------------------------------------------------


class TestApplyMotif:
    def test_rule_motif_adds_one_accent_shape(self) -> None:
        _, slide = _blank_slide()
        theme = gen.THEMES["terra"]
        gen.apply_motif(slide, "rule", theme, Inches(13.333))
        shapes = list(slide.shapes)
        assert len(shapes) == 1
        assert shapes[0].fill.fore_color.rgb == theme["accent"]

    def test_corner_motif_adds_two_accent_shapes(self) -> None:
        _, slide = _blank_slide()
        theme = gen.THEMES["noir"]
        gen.apply_motif(slide, "corner", theme, Inches(13.333))
        shapes = list(slide.shapes)
        assert len(shapes) == 2
        assert all(shape.fill.fore_color.rgb == theme["accent"] for shape in shapes)

    def test_dot_grid_motif_adds_nine_dots_top_right(self) -> None:
        _, slide = _blank_slide()
        theme = gen.THEMES["boardroom"]
        slide_width = Inches(13.333)
        gen.apply_motif(slide, "dot_grid", theme, slide_width)
        shapes = list(slide.shapes)
        assert len(shapes) == 9
        for shape in shapes:
            assert shape.width == Pt(4)
            assert shape.height == Pt(4)
            assert shape.left > int(slide_width) / 2
            assert shape.fill.fore_color.rgb == theme["accent"]

    @pytest.mark.parametrize("motif", [None, "", "zigzag", 42])
    def test_absent_or_unknown_motif_is_noop(self, motif) -> None:
        _, slide = _blank_slide()
        gen.apply_motif(slide, motif, gen.THEMES["daylight"], Inches(13.333))
        assert len(list(slide.shapes)) == 0

    def test_motif_is_normalized(self) -> None:
        _, slide = _blank_slide()
        gen.apply_motif(slide, "  Rule ", gen.THEMES["daylight"], Inches(13.333))
        assert len(list(slide.shapes)) == 1

    @pytest.mark.parametrize("layout_name", ["content_text", "content_image", "two_column", "stat_band"])
    def test_titled_layouts_render_plan_motif(self, layout_name: str, tmp_path: Path) -> None:
        slide_info = {"slide_number": 1, "title": "T", "key_points": ["a", "b"]}
        image_path = None
        if layout_name == "content_image":
            image_path = str(_write_png(tmp_path / "chart.png"))
        if layout_name == "stat_band":
            slide_info["stats"] = [{"value": "1", "label": "one"}, {"value": "2", "label": "two"}]

        _, plain_slide = _blank_slide()
        gen.LAYOUT_DISPATCH[layout_name](plain_slide, slide_info, {"theme": "terra"}, image_path, Inches(13.333), Inches(7.5))
        _, motif_slide = _blank_slide()
        gen.LAYOUT_DISPATCH[layout_name](motif_slide, slide_info, {"theme": "terra", "motif": "rule"}, image_path, Inches(13.333), Inches(7.5))

        assert len(list(motif_slide.shapes)) == len(list(plain_slide.shapes)) + 1


# ---------------------------------------------------------------------------
# stat_band layout
# ---------------------------------------------------------------------------


class TestStatBandLayout:
    def test_explicit_layout_resolves_but_is_never_inferred(self) -> None:
        assert gen.resolve_layout({"layout": "stat_band"}, None) == "stat_band"
        assert gen.resolve_layout({"title": "x", "stats": [{"value": "1", "label": "l"}]}, None) == "content_text"

    def test_values_and_labels_render_with_display_typography(self) -> None:
        _, slide = _blank_slide()
        theme = gen.THEMES["noir"]
        slide_info = {
            "slide_number": 2,
            "title": "Numbers",
            "stats": [{"value": "87%", "label": "adoption"}, {"value": "3x", "label": "throughput"}],
        }
        gen.add_stat_band_slide(slide, slide_info, {"theme": "noir"}, None, Inches(13.333), Inches(7.5))

        texts = _slide_texts(slide)
        assert {"87%", "adoption", "3x", "throughput"}.issubset(set(texts))
        value_paragraph = next(p for p in _slide_paragraphs(slide) if p.text == "87%")
        assert value_paragraph.font.size == Pt(54)
        assert value_paragraph.font.bold is True
        assert value_paragraph.font.color.rgb == theme["accent"]
        label_paragraph = next(p for p in _slide_paragraphs(slide) if p.text == "adoption")
        assert label_paragraph.font.size == Pt(14)

    def test_caps_at_four_stats(self) -> None:
        _, slide = _blank_slide()
        stats = [{"value": f"v{i}", "label": f"l{i}"} for i in range(1, 6)]
        gen.add_stat_band_slide(slide, {"stats": stats}, {}, None, Inches(13.333), Inches(7.5))
        texts = set(_slide_texts(slide))
        assert {"v1", "v2", "v3", "v4"}.issubset(texts)
        assert "v5" not in texts

    def test_falls_back_to_two_column_without_stats(self) -> None:
        _, stat_slide = _blank_slide()
        slide_info = {"slide_number": 1, "title": "T", "key_points": ["alpha", "beta"]}
        gen.add_stat_band_slide(stat_slide, slide_info, {}, None, Inches(13.333), Inches(7.5))
        _, two_col_slide = _blank_slide()
        gen.add_two_column_slide(two_col_slide, slide_info, {}, None, Inches(13.333), Inches(7.5))

        assert {"alpha", "beta"}.issubset(set(_slide_texts(stat_slide)))
        assert len(list(stat_slide.shapes)) == len(list(two_col_slide.shapes))

    def test_optional_title_is_skipped_when_absent(self) -> None:
        _, slide = _blank_slide()
        gen.add_stat_band_slide(slide, {"stats": [{"value": "9", "label": "nine"}]}, {"title": "Deck Title"}, None, Inches(13.333), Inches(7.5))
        assert "Deck Title" not in set(_slide_texts(slide))

    def test_stat_band_renders_through_generate_ppt(self, tmp_path: Path) -> None:
        plan = {
            "title": "Stats",
            "theme": "terra",
            "slides": [{"slide_number": 1, "layout": "stat_band", "title": "KPIs", "stats": [{"value": "42", "label": "answers"}]}],
        }
        plan_file = tmp_path / "plan.json"
        plan_file.write_text(json.dumps(plan), encoding="utf-8")
        output = tmp_path / "deck.pptx"

        message = gen.generate_ppt(str(plan_file), [], str(output))

        assert message == "Successfully generated presentation with 1 slides (picture_count=0)"
        prs = Presentation(str(output))
        assert {"42", "answers"}.issubset(set(_slide_texts(prs.slides[0])))


# ---------------------------------------------------------------------------
# lint_plan
# ---------------------------------------------------------------------------


class TestLintPlan:
    def test_clean_plan_has_no_warnings(self) -> None:
        plan = {
            "title": "Clean",
            "slides": [
                {"slide_number": 1, "layout": "title", "title": "Clean"},
                {"slide_number": 2, "layout": "content_text", "title": "Context", "key_points": ["a"]},
                {"slide_number": 3, "layout": "section_divider", "title": "Part"},
                {"slide_number": 4, "layout": "two_column", "title": "Tradeoffs"},
                {"slide_number": 5, "layout": "quote", "quote": "q"},
                {"slide_number": 6, "layout": "closing"},
            ],
        }
        assert gen.lint_plan(plan) == []

    def test_consecutive_identical_layouts_warn_with_slide_numbers(self) -> None:
        plan = {
            "slides": [
                {"slide_number": 1, "layout": "content_text", "title": "A"},
                {"slide_number": 2, "layout": "content_text", "title": "B"},
                {"slide_number": 3, "layout": "quote", "quote": "q"},
            ],
        }
        warnings = gen.lint_plan(plan)
        assert len(warnings) == 1
        assert "slides 1 and 2" in warnings[0]
        assert "content_text" in warnings[0]
        assert "reorder" in warnings[0].lower()

    def test_visual_cadence_warning_names_the_dry_stretch(self) -> None:
        plan = {
            "slides": [
                {"slide_number": 1, "layout": "content_text", "title": "A"},
                {"slide_number": 2, "layout": "two_column", "title": "B"},
                {"slide_number": 3, "layout": "content_text", "title": "C"},
                {"slide_number": 4, "layout": "two_column", "title": "D"},
            ],
        }
        warnings = gen.lint_plan(plan)
        assert len(warnings) == 1
        assert "slides 1-4" in warnings[0]
        assert "visual anchor" in warnings[0]

    def test_image_bearing_slide_counts_as_visual_anchor(self) -> None:
        plan = {
            "slides": [
                {"slide_number": 1, "layout": "content_text", "title": "A"},
                {"slide_number": 2, "layout": "two_column", "title": "B", "image": "/mnt/user-data/outputs/visuals/x.png"},
                {"slide_number": 3, "layout": "content_text", "title": "C"},
                {"slide_number": 4, "layout": "two_column", "title": "D"},
            ],
        }
        assert gen.lint_plan(plan) == []

    def test_cadence_uses_inferred_layouts(self) -> None:
        # No explicit layout fields at all: inference yields content_text x3.
        plan = {
            "slides": [
                {"slide_number": 1, "title": "A", "key_points": ["x"]},
                {"slide_number": 2, "title": "B", "key_points": ["y"]},
                {"slide_number": 3, "title": "C", "key_points": ["z"]},
            ],
        }
        warnings = gen.lint_plan(plan)
        assert any("visual anchor" in warning for warning in warnings)
        assert any("content_text" in warning for warning in warnings)

    def test_long_title_warns(self) -> None:
        long_title = "T" * 61
        plan = {"slides": [{"slide_number": 1, "layout": "quote", "title": long_title, "quote": "q"}]}
        warnings = gen.lint_plan(plan)
        assert len(warnings) == 1
        assert ">60" in warnings[0]
        assert "slide 1" in warnings[0]

    def test_lint_tolerates_empty_or_missing_slides(self) -> None:
        assert gen.lint_plan({}) == []
        assert gen.lint_plan({"slides": []}) == []

    def test_generate_ppt_emits_plan_lint_to_stderr_without_failing(self, tmp_path: Path, capsys) -> None:
        plan = {
            "title": "Lint Me",
            "slides": [
                {"slide_number": 1, "layout": "content_text", "title": "A", "key_points": ["x"]},
                {"slide_number": 2, "layout": "content_text", "title": "B", "key_points": ["y"]},
                {"slide_number": 3, "layout": "content_text", "title": "C", "key_points": ["z"]},
            ],
        }
        plan_file = tmp_path / "plan.json"
        plan_file.write_text(json.dumps(plan), encoding="utf-8")
        output = tmp_path / "deck.pptx"

        message = gen.generate_ppt(str(plan_file), [], str(output))

        # Success-message contract unchanged; warnings only land on stderr.
        assert message == "Successfully generated presentation with 3 slides (picture_count=0)"
        err = capsys.readouterr().err
        # 2 consecutive-layout warnings + 1 cadence warning + summary line.
        assert err.count("PLAN_LINT:") == 4
        assert "PLAN_LINT: 3 warning(s)" in err

    def test_clean_plan_emits_no_plan_lint_lines(self, tmp_path: Path, capsys) -> None:
        plan = {
            "title": "Quiet",
            "slides": [
                {"slide_number": 1, "layout": "title", "title": "Quiet"},
                {"slide_number": 2, "layout": "content_text", "title": "Body", "key_points": ["a"]},
            ],
        }
        plan_file = tmp_path / "plan.json"
        plan_file.write_text(json.dumps(plan), encoding="utf-8")
        output = tmp_path / "deck.pptx"

        gen.generate_ppt(str(plan_file), [], str(output))

        assert "PLAN_LINT" not in capsys.readouterr().err

    def test_cli_keeps_diagnostics_contract_and_appends_lint(self, tmp_path: Path) -> None:
        plan = {
            "title": "CLI Lint",
            "slides": [
                {"slide_number": 1, "layout": "content_text", "title": "T" * 61, "key_points": ["a"]},
                {"slide_number": 2, "layout": "quote", "quote": "q"},
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
        assert "PLAN_LINT: 1 warning(s)" in result.stderr
