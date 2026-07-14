from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from PIL import ImageFont
from pptx import Presentation
from pptx.util import Inches, Pt

PROJECT_ROOT = Path(__file__).resolve().parents[2]
HTML2PATCH_PATH = (
    PROJECT_ROOT
    / "third_party/hands_on_deck/skills/hands-on-deck/scripts/html2patch.py"
)
INVENTORY_PATH = (
    PROJECT_ROOT
    / "third_party/hands_on_deck/skills/hands-on-deck/scripts/inventory.py"
)


def _html2patch_module():
    spec = importlib.util.spec_from_file_location("sophia_html2patch", HTML2PATCH_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _inventory_module():
    spec = importlib.util.spec_from_file_location("sophia_hands_on_deck_inventory", INVENTORY_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_inventory_measurement_converts_points_to_pixels_and_preserves_weight(monkeypatch) -> None:
    module = _inventory_module()
    captured: list[tuple[str, int, bool, bool]] = []

    def fake_font(font_name: str, size: int, *, bold: bool = False, italic: bool = False):
        captured.append((font_name, size, bold, italic))
        return ImageFont.load_default(size=size)

    monkeypatch.setattr(module, "load_measure_font", fake_font)
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    shape = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(8), Inches(0.6))
    shape.text_frame.margin_left = 0
    shape.text_frame.margin_right = 0
    shape.text_frame.margin_top = 0
    shape.text_frame.margin_bottom = 0
    paragraph = shape.text_frame.paragraphs[0]
    paragraph.text = "Habitat is fragmented, not absent"
    run = paragraph.runs[0]
    run.font.name = "Georgia"
    run.font.size = Pt(37.5)
    run.font.bold = True

    module.ShapeData(shape, slide=slide)

    assert captured == [("Georgia", 50, True, False)]


def test_inventory_fit_scale_keeps_largest_fitting_size() -> None:
    module = _inventory_module()
    shape_data = object.__new__(module.ShapeData)
    shape_data._frame_overflow_inches = lambda *, font_scale=1.0: (  # type: ignore[method-assign]
        None if font_scale <= 0.84 else 0.6
    )

    assert shape_data.font_scale_to_fit(0.6) == 0.84


def test_inventory_treats_required_cambria_heading_font_as_serif() -> None:
    module = _inventory_module()

    assert "cambria" in module.SERIF_HINTS
    fallbacks = module._fallback_font_paths(
        serif=True,
        bold=True,
        italic=False,
        font_name="Cambria",
    )
    assert fallbacks[0].endswith("/Caladea-Bold.ttf")


def test_inventory_measures_later_mixed_runs_with_their_own_font_metrics(monkeypatch) -> None:
    module = _inventory_module()
    captured: list[tuple[str, int, bool, bool]] = []

    def fake_font(font_name: str, size: int, *, bold: bool = False, italic: bool = False):
        captured.append((font_name, size, bold, italic))
        return ImageFont.load_default(size=size)

    monkeypatch.setattr(module, "load_measure_font", fake_font)
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    shape = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(3), Inches(0.6))
    shape.text_frame.margin_left = 0
    shape.text_frame.margin_right = 0
    shape.text_frame.margin_top = 0
    shape.text_frame.margin_bottom = 0
    paragraph = shape.text_frame.paragraphs[0]
    paragraph.clear()
    lead = paragraph.add_run()
    lead.text = "Signal "
    lead.font.name = "Arial"
    lead.font.size = Pt(12)
    emphasis = paragraph.add_run()
    emphasis.text = "critical corridor failure"
    emphasis.font.name = "Cambria"
    emphasis.font.size = Pt(40)
    emphasis.font.bold = True

    shape_data = module.ShapeData(shape, slide=slide)

    assert ("Arial", 16, False, False) in captured
    assert ("Cambria", 53, True, False) in captured
    assert shape_data.frame_overflow_bottom is not None


def test_one_source_element_maps_deterministically_to_box_and_text_shapes(tmp_path: Path) -> None:
    module = _html2patch_module()
    source = {
        "sourceId": "system-title",
        "sourceRole": "title",
        "sourceRequired": True,
    }
    extract = {
        "items": [
            {
                **source,
                "type": "box",
                "box": {"x": 100, "y": 80, "w": 900, "h": 120},
                "rotation": 0,
                "fill": "FFFFFF",
                "fillAlpha": 1,
                "gradient": None,
                "border": {"color": "111827", "w": 2, "dashed": False},
                "partialBorders": [],
                "radiusPx": 0,
            },
            {
                **source,
                "type": "text",
                "box": {"x": 120, "y": 90, "w": 860, "h": 90},
                "rotation": 0,
                "vanchor": "middle",
                "paragraphs": [
                    {
                        "lineHeightPx": 42,
                        "runs": [
                            {
                                "text": "System title",
                                "style": {
                                    "font": "Arial",
                                    "sizePx": 36,
                                    "color": "111827",
                                    "alpha": 1,
                                    "bold": True,
                                    "italic": False,
                                    "underline": False,
                                    "link": None,
                                },
                            }
                        ],
                    }
                ],
                "meta": {
                    "align": "left",
                    "lineHeightPx": 42,
                    "fontSizePx": 36,
                    "padding": [0, 0, 0, 0],
                },
            },
        ]
    }
    source_map: dict = {"schema_version": "sophia-deck-source-map/v1", "slides": {}}

    operations = module.compile_page(
        extract,
        0,
        tmp_path / "slide.html",
        tmp_path,
        "s1",
        [],
        source_map,
    )

    names = source_map["slides"]["slide:1"]["elements"]["system-title"]["shape_names"]
    assert names == ["s1-system-title-box-1", "s1-system-title-text-1"]
    assert [operation["name"] for operation in operations] == names


def test_descendant_shapes_map_to_direct_and_all_semantic_ancestors(tmp_path: Path) -> None:
    module = _html2patch_module()

    def box(source_id: str, x: int) -> dict:
        direct = {
            "sourceId": source_id,
            "sourceRole": "detail",
            "sourceRequired": True,
        }
        return {
            **direct,
            "sourceRefs": [
                direct,
                {
                    "sourceId": "cluster",
                    "sourceRole": "diagram",
                    "sourceRequired": True,
                },
                {
                    "sourceId": "system",
                    "sourceRole": "architecture",
                    "sourceRequired": True,
                },
            ],
            "type": "box",
            "box": {"x": x, "y": 160, "w": 300, "h": 180},
            "rotation": 0,
            "fill": "E2E8F0",
            "fillAlpha": 1,
            "gradient": None,
            "border": None,
            "partialBorders": [],
            "radiusPx": 0,
        }

    extract = {"items": [box("node-a", 100), box("node-b", 440)]}
    source_map: dict = {"schema_version": "sophia-deck-source-map/v1", "slides": {}}

    operations = module.compile_page(
        extract,
        0,
        tmp_path / "slide.html",
        tmp_path,
        "s1",
        [],
        source_map,
    )

    operation_names = [operation["name"] for operation in operations]
    assert operation_names == ["s1-node-a-box-1", "s1-node-b-box-1"]
    elements = source_map["slides"]["slide:1"]["elements"]
    assert elements["node-a"]["shape_names"] == ["s1-node-a-box-1"]
    assert elements["node-b"]["shape_names"] == ["s1-node-b-box-1"]
    assert elements["cluster"]["shape_names"] == operation_names
    assert elements["system"]["shape_names"] == operation_names
    assert elements["cluster"]["source_required"] is True
    assert elements["system"]["source_role"] == "architecture"
