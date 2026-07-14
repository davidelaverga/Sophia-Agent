from __future__ import annotations

import importlib.util
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
HTML2PATCH_PATH = (
    PROJECT_ROOT
    / "third_party/hands_on_deck/skills/hands-on-deck/scripts/html2patch.py"
)


def _html2patch_module():
    spec = importlib.util.spec_from_file_location("sophia_html2patch", HTML2PATCH_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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
