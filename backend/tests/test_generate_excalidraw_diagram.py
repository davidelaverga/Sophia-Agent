import json
from types import SimpleNamespace

from PIL import Image

from deerflow.sophia.tools.generate_excalidraw_diagram import generate_excalidraw_diagram


def _runtime(outputs_path):
    return SimpleNamespace(
        state={"thread_data": {"outputs_path": str(outputs_path)}},
        context={},
        config={},
    )


def _payload(result: str) -> dict:
    return json.loads(result)


def test_generate_excalidraw_diagram_writes_scene_svg_and_png(tmp_path) -> None:
    outputs = tmp_path / "outputs"

    payload = _payload(
        generate_excalidraw_diagram.func(
            runtime=_runtime(outputs),
            diagram_type="architecture",
            title="Agent Runtime",
            nodes=[
                {"id": "companion", "label": "Companion"},
                {"id": "builder", "label": "Builder"},
                {"id": "artifact", "label": "Artifact Store"},
            ],
            edges=[
                {"from": "companion", "to": "builder", "label": "delegates"},
                {"from": "builder", "to": "artifact", "label": "emits"},
            ],
            output_name="agent-runtime",
        )
    )

    assert payload["success"] is True
    assert payload["visual_type"] == "architecture"
    assert payload["excalidraw_path"] == "/mnt/user-data/outputs/visuals/agent-runtime.excalidraw"
    assert payload["svg_path"] == "/mnt/user-data/outputs/visuals/agent-runtime.svg"
    assert payload["png_path"] == "/mnt/user-data/outputs/visuals/agent-runtime.png"
    assert payload["node_count"] == 3
    assert payload["edge_count"] == 2
    assert payload["svg_bytes"] > 500
    assert payload["png_bytes"] > 0

    scene = json.loads((outputs / "visuals" / "agent-runtime.excalidraw").read_text(encoding="utf-8"))
    assert scene["type"] == "excalidraw"
    assert scene["source"] == "sophia-builder"
    assert any(element["type"] == "arrow" for element in scene["elements"])
    with Image.open(outputs / "visuals" / "agent-runtime.png") as image:
        image.load()
        assert image.size == (1280, 720)


def test_generate_excalidraw_diagram_rejects_weak_specs(tmp_path) -> None:
    payload = _payload(
        generate_excalidraw_diagram.func(
            runtime=_runtime(tmp_path / "outputs"),
            diagram_type="process_flow",
            title="Too Thin",
            nodes=[{"id": "one", "label": "Only one node"}],
        )
    )

    assert payload["success"] is False
    assert payload["error_type"] == "insufficient_nodes"
