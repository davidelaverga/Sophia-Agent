from __future__ import annotations

from pathlib import Path


def test_langgraph_declares_openai_api_key_secret() -> None:
    render_yaml = Path(__file__).resolve().parents[2] / "render.yaml"
    lines = render_yaml.read_text(encoding="utf-8").splitlines()

    in_langgraph = False
    langgraph_block: list[str] = []
    for line in lines:
        if line.startswith("  - type:") and in_langgraph:
            break
        if line.strip() == "name: sophia-langgraph":
            in_langgraph = True
        if in_langgraph:
            langgraph_block.append(line)

    joined = "\n".join(langgraph_block)
    assert "name: sophia-langgraph" in joined
    assert "key: OPENAI_API_KEY" in joined
    assert "sync: false" in joined
