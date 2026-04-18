from __future__ import annotations

import base64
import importlib
from types import SimpleNamespace

from langchain_core.utils.function_calling import convert_to_openai_tool

from deerflow.config.paths import Paths
from deerflow.config.tool_config import ToolConfig

builder_agent_module = importlib.import_module("deerflow.agents.sophia_agent.builder_agent")
share_builder_artifact_module = importlib.import_module("deerflow.sophia.tools.share_builder_artifact")
switch_to_builder_module = importlib.import_module("deerflow.sophia.tools.switch_to_builder")


def _make_runtime(*, state: dict | None = None, thread_id: str = "thread-123") -> SimpleNamespace:
    return SimpleNamespace(
        state=state or {},
        context={"thread_id": thread_id},
        config={"configurable": {"thread_id": thread_id}},
    )


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


def test_share_builder_artifact_tool_schema_is_json_serializable():
    tool_definition = convert_to_openai_tool(share_builder_artifact_module.share_builder_artifact)

    assert tool_definition["function"]["name"] == "share_builder_artifact"
    assert tool_definition["function"]["parameters"] == {"properties": {}, "type": "object"}


def test_share_builder_artifact_without_previous_result_returns_tool_message():
    result = share_builder_artifact_module.share_builder_artifact.func(
        runtime=_make_runtime(),
        tool_call_id="tc-1",
    )

    assert "builder_delivery" not in result.update
    assert result.update["messages"][0].content == "There is no previous builder deliverable available to share in this chat."


def test_share_builder_artifact_attaches_latest_builder_delivery(monkeypatch):
    builder_delivery = {
        "source": "builder_result",
        "attachments": [{"virtual_path": "/mnt/user-data/outputs/brief.md"}],
    }

    def _build_builder_delivery_payload(*, thread_id, builder_result):
        assert thread_id == "thread-123"
        assert builder_result["artifact_path"] == "outputs/brief.md"
        return builder_delivery

    monkeypatch.setattr(
        share_builder_artifact_module,
        "build_builder_delivery_payload",
        _build_builder_delivery_payload,
    )

    result = share_builder_artifact_module.share_builder_artifact.func(
        runtime=_make_runtime(
            state={
                "builder_result": {
                    "artifact_title": "brief.md",
                    "artifact_path": "outputs/brief.md",
                }
            }
        ),
        tool_call_id="tc-2",
    )

    assert result.update["builder_delivery"] == builder_delivery
    assert result.update["messages"][0].content == "brief.md is attached for this reply. Briefly tell the user that you are sending it now."


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


def test_extract_builder_result_uses_present_files_fallback():
    result = SimpleNamespace(
        task_id="toolu_fallback",
        final_state=None,
        ai_messages=[
            {
                "tool_calls": [
                    {
                        "name": "present_files",
                        "args": {"filepaths": ["outputs/brief.md", "outputs/appendix.md"]},
                    }
                ]
            }
        ],
        result="Draft deliverable is ready.",
    )

    builder_result = switch_to_builder_module.extract_builder_result_from_subagent_result(result)

    assert builder_result["artifact_path"] == "outputs/brief.md"
    assert builder_result["supporting_files"] == ["outputs/appendix.md"]
    assert builder_result["artifact_title"] == "brief.md"
    assert builder_result["artifact_type"] == "document"
    assert builder_result["companion_summary"] == "Draft deliverable is ready."


def test_builder_agent_defaults_to_stronger_model(monkeypatch):
    monkeypatch.delenv("SOPHIA_BUILDER_MODEL", raising=False)

    model_name, source = builder_agent_module._resolve_builder_model_name()

    assert model_name == "claude-sonnet-4-6"
    assert source == "default"
