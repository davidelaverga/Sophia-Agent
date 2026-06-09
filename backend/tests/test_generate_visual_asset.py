import json
from types import SimpleNamespace

from PIL import Image

from deerflow.sophia.tools.generate_visual_asset import generate_visual_asset


def _runtime(outputs_path):
    return SimpleNamespace(
        state={"thread_data": {"outputs_path": str(outputs_path)}},
        context={},
        config={},
    )


def _payload(result: str) -> dict:
    return json.loads(result)


def test_generate_visual_asset_writes_svg_and_png_under_visuals(tmp_path) -> None:
    outputs = tmp_path / "outputs"

    payload = _payload(
        generate_visual_asset.func(
            runtime=_runtime(outputs),
            visual_type="bar_chart",
            title="Capability Comparison",
            data=[
                {"label": "HTML", "value": 9},
                {"label": "PDF", "value": 5},
                {"label": "PPTX", "value": 4},
            ],
            output_name="capability-comparison",
        )
    )

    assert payload["success"] is True
    assert payload["svg_path"] == "/mnt/user-data/outputs/visuals/capability-comparison.svg"
    assert payload["png_path"] == "/mnt/user-data/outputs/visuals/capability-comparison.png"
    svg_file = outputs / "visuals" / "capability-comparison.svg"
    png_file = outputs / "visuals" / "capability-comparison.png"
    assert svg_file.is_file()
    assert png_file.is_file()
    assert payload["svg_bytes"] > 100
    assert payload["png_bytes"] > 0
    assert payload["png_render_engine"] in {"cairosvg", "svglib", "pillow_svg_subset"}
    assert payload["png_validation_status"] == "ok"

    with Image.open(png_file) as image:
        image.load()
        assert image.size == (960, 540)
        extrema = image.convert("L").getextrema()
    assert extrema[0] != extrema[1]


def test_generate_visual_asset_rejects_invalid_dimensions(tmp_path) -> None:
    payload = _payload(
        generate_visual_asset.func(
            runtime=_runtime(tmp_path / "outputs"),
            visual_type="timeline",
            title="Too large",
            data=["A", "B"],
            width=9999,
        )
    )

    assert payload["success"] is False
    assert payload["error_type"] == "invalid_dimensions"
