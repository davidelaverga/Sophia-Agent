import json
import shutil
from types import SimpleNamespace

from PIL import Image

from deerflow.sophia.tools.generate_excalidraw_diagram import generate_excalidraw_diagram

_HAS_DOT = shutil.which("dot") is not None


def _runtime(outputs_path):
    return SimpleNamespace(
        state={"thread_data": {"outputs_path": str(outputs_path)}},
        context={},
        config={},
    )


def _payload(result: str) -> dict:
    return json.loads(result)


def test_generate_excalidraw_diagram_renders_via_graphviz(tmp_path) -> None:
    # Artifact Visual System Phase 2: the diagram tool was ported from the
    # mermaid→excalidraw stack to graphviz. There is no longer a .excalidraw
    # scene file — the deliverables are an SVG + PNG rendered by the `dot`
    # binary, and the payload reports layout_engine="graphviz". When `dot`
    # is absent (local dev without the runtime image) the tool degrades
    # gracefully with error_type="graphviz_unavailable" rather than raising.
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

    if not _HAS_DOT:
        assert payload["success"] is False
        assert payload["error_type"] == "graphviz_unavailable"
        return

    assert payload["success"] is True
    assert payload["visual_type"] == "architecture"
    assert payload["layout_engine"] == "graphviz-dot:architecture"
    assert payload["svg_path"] == "/mnt/user-data/outputs/visuals/agent-runtime.svg"
    assert payload["png_path"] == "/mnt/user-data/outputs/visuals/agent-runtime.png"
    assert payload["node_count"] == 3
    assert payload["edge_count"] == 2
    assert payload["svg_bytes"] > 500
    assert payload["png_bytes"] > 0
    # The retired excalidraw scene contract is gone.
    assert "excalidraw_path" not in payload
    assert not (outputs / "visuals" / "agent-runtime.excalidraw").exists()

    with Image.open(outputs / "visuals" / "agent-runtime.png") as image:
        image.load()
        assert image.size[0] > 0 and image.size[1] > 0


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
