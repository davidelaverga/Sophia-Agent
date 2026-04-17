from __future__ import annotations

import base64
from types import SimpleNamespace

from deerflow.config.paths import Paths
from deerflow.config.tool_config import ToolConfig


def test_build_builder_delivery_payload_reads_thread_outputs(monkeypatch, tmp_path):
    from deerflow.sophia.tools.builder_delivery import build_builder_delivery_payload

    paths = Paths(str(tmp_path))
    thread_id = "thread-123"
    paths.ensure_thread_dirs(thread_id)
    output_path = paths.sandbox_outputs_dir(thread_id) / "brief.md"
    output_path.write_text("hello from output", encoding="utf-8")

    monkeypatch.setattr("deerflow.sophia.tools.builder_delivery.get_paths", lambda: paths)

    payload = build_builder_delivery_payload(
        thread_id=thread_id,
        builder_result={"artifact_path": "outputs/brief.md"},
    )

    assert payload is not None
    assert payload["source"] == "builder_result"
    assert payload["attachments"][0]["virtual_path"] == "/mnt/user-data/outputs/brief.md"
    assert payload["attachments"][0]["filename"] == "brief.md"
    assert payload["attachments"][0]["mime_type"].startswith("text/")
    assert payload["attachments"][0]["content_base64"] == base64.b64encode(b"hello from output").decode("ascii")


def test_load_sophia_web_tools_only_returns_native_web_tools(monkeypatch):
    from deerflow.agents.sophia_agent.tooling import load_sophia_web_tools

    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.tooling.get_app_config",
        lambda: SimpleNamespace(
            tools=[
                ToolConfig(name="ls", group="file:read", use="deerflow.sandbox.tools:ls_tool"),
                ToolConfig(name="web_search", group="web", use="deerflow.community.tavily.tools:web_search_tool"),
                ToolConfig(name="web_fetch", group="web", use="deerflow.community.jina_ai.tools:web_fetch_tool"),
            ]
        ),
    )
    monkeypatch.setattr(
        "deerflow.agents.sophia_agent.tooling.resolve_variable",
        lambda use, _base: SimpleNamespace(name="web_search" if "web_search_tool" in use else "web_fetch"),
    )

    tools = load_sophia_web_tools()

    assert [tool.name for tool in tools] == ["web_search", "web_fetch"]
