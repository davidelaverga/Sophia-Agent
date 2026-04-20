from __future__ import annotations

import base64
import importlib
from types import SimpleNamespace

from langchain_core.utils.function_calling import convert_to_openai_tool

from deerflow.config.paths import Paths
from deerflow.config.tool_config import ToolConfig
from deerflow.sophia.tools._tool_call_id import resolve_tool_call_id

builder_agent_module = importlib.import_module("deerflow.agents.sophia_agent.builder_agent")
share_builder_artifact_module = importlib.import_module("deerflow.sophia.tools.share_builder_artifact")
switch_to_builder_module = importlib.import_module("deerflow.sophia.tools.switch_to_builder")


def _make_runtime(
    *,
    state: dict | None = None,
    thread_id: str = "thread-123",
    runtime_tool_call_id: str | None = None,
) -> SimpleNamespace:
    runtime = SimpleNamespace(
        state=state or {},
        context={"thread_id": thread_id},
        config={"configurable": {"thread_id": thread_id}},
    )
    if runtime_tool_call_id is not None:
        runtime.tool_call_id = runtime_tool_call_id
    return runtime


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


class TestResolveToolCallId:
    def test_prefers_runtime_tool_call_id_over_injected(self):
        runtime = _make_runtime(runtime_tool_call_id="toolu_runtime")

        resolved = resolve_tool_call_id(runtime, "toolu_injected", tool_name="share_builder_artifact")

        assert resolved == "toolu_runtime"

    def test_falls_back_to_injected_when_runtime_id_is_empty(self):
        runtime = _make_runtime(runtime_tool_call_id="")

        resolved = resolve_tool_call_id(runtime, "toolu_injected", tool_name="share_builder_artifact")

        assert resolved == "toolu_injected"

    def test_falls_back_to_injected_when_runtime_has_no_attr(self):
        runtime = _make_runtime()

        resolved = resolve_tool_call_id(runtime, "toolu_injected", tool_name="share_builder_artifact")

        assert resolved == "toolu_injected"

    def test_raises_when_neither_source_has_id(self):
        runtime = _make_runtime(runtime_tool_call_id="")

        try:
            resolve_tool_call_id(runtime, "", tool_name="share_builder_artifact")
        except ValueError as exc:
            assert "share_builder_artifact" in str(exc)
        else:
            raise AssertionError("resolve_tool_call_id should have raised ValueError")

    def test_handles_runtime_none(self):
        resolved = resolve_tool_call_id(None, "toolu_injected", tool_name="switch_to_builder")

        assert resolved == "toolu_injected"


class TestShareBuilderArtifactToolCallIdIntegrity:
    def test_uses_runtime_tool_call_id_when_injected_is_empty(self, monkeypatch):
        monkeypatch.setattr(
            share_builder_artifact_module,
            "build_builder_delivery_payload",
            lambda *, thread_id, builder_result: {
                "source": "builder_result",
                "attachments": [{"virtual_path": "/mnt/user-data/outputs/brief.md"}],
            },
        )

        result = share_builder_artifact_module.share_builder_artifact.func(
            runtime=_make_runtime(
                state={
                    "builder_result": {
                        "artifact_title": "brief.md",
                        "artifact_path": "outputs/brief.md",
                    }
                },
                runtime_tool_call_id="toolu_from_runtime",
            ),
            tool_call_id="",
        )

        assert result.update["messages"][0].tool_call_id == "toolu_from_runtime"
        assert result.update["messages"][0].name == "share_builder_artifact"

    def test_no_previous_deliverable_branch_emits_paired_tool_message(self):
        result = share_builder_artifact_module.share_builder_artifact.func(
            runtime=_make_runtime(runtime_tool_call_id="toolu_no_state"),
            tool_call_id="",
        )

        message = result.update["messages"][0]
        assert message.tool_call_id == "toolu_no_state"
        assert message.name == "share_builder_artifact"
        assert message.content == "There is no previous builder deliverable available to share in this chat."

    def test_delivery_unavailable_branch_emits_paired_tool_message(self, monkeypatch):
        monkeypatch.setattr(
            share_builder_artifact_module,
            "build_builder_delivery_payload",
            lambda *, thread_id, builder_result: None,
        )

        result = share_builder_artifact_module.share_builder_artifact.func(
            runtime=_make_runtime(
                state={
                    "builder_result": {
                        "artifact_title": "brief.md",
                        "artifact_path": "outputs/brief.md",
                    }
                },
                runtime_tool_call_id="toolu_partial",
            ),
            tool_call_id="",
        )

        message = result.update["messages"][0]
        assert message.tool_call_id == "toolu_partial"
        assert message.name == "share_builder_artifact"
        assert "could not be attached" in message.content

    def test_raises_when_no_tool_call_id_anywhere(self):
        try:
            share_builder_artifact_module.share_builder_artifact.func(
                runtime=_make_runtime(runtime_tool_call_id=""),
                tool_call_id="",
            )
        except ValueError as exc:
            assert "share_builder_artifact" in str(exc)
        else:
            raise AssertionError("share_builder_artifact should have raised ValueError")


class TestSwitchToBuilderErrorCommand:
    def test_format_error_command_emits_paired_tool_message(self):
        command = switch_to_builder_module._format_error_command(
            "Task disappeared",
            "toolu_error_id",
        )

        message = command.update["messages"][0]
        assert message.tool_call_id == "toolu_error_id"
        assert message.name == "switch_to_builder"
        # Default retry_attempt=0 produces the retry-offer phrasing with the
        # underlying error embedded.
        assert "Task disappeared" in message.content
        assert "try again" in message.content.lower()

    def test_format_error_command_first_attempt_offers_retry(self):
        command = switch_to_builder_module._format_error_command(
            "Network blip",
            "toolu_first",
            retry_attempt=0,
        )
        content = command.update["messages"][0].content
        assert "try again" in content.lower()
        assert "alternatives" not in content.lower()

    def test_format_error_command_second_attempt_offers_alternatives(self):
        command = switch_to_builder_module._format_error_command(
            "Still broken",
            "toolu_second",
            retry_attempt=1,
        )
        content = command.update["messages"][0].content
        assert "alternatives" in content.lower()
        # The companion must be told not to silently retry again.
        assert "do not delegate" in content.lower() or "do not delegate" in content.lower()


class TestSwitchToBuilderTimeouts:
    def test_known_task_types_have_explicit_timeouts(self):
        # Every Literal option on SwitchToBuilderInput should have an entry
        # in TASK_TYPE_TIMEOUTS to avoid accidentally falling back to the
        # default for a supported type.
        expected = {"frontend", "presentation", "research", "document", "visual_report"}
        assert expected.issubset(switch_to_builder_module.TASK_TYPE_TIMEOUTS.keys())

    def test_resolve_builder_timeout_for_research(self):
        assert switch_to_builder_module.resolve_builder_timeout("research") == 900

    def test_resolve_builder_timeout_for_document(self):
        assert switch_to_builder_module.resolve_builder_timeout("document") == 600

    def test_resolve_builder_timeout_for_unknown_task_type_falls_back(self):
        assert (
            switch_to_builder_module.resolve_builder_timeout("nope")
            == switch_to_builder_module.DEFAULT_TIMEOUT_SECONDS
        )

    def test_timeouts_are_strictly_greater_than_previous_120s_default(self):
        # Regression guard: the whole point of PR G Commit 1 is that the
        # short 120s timeout was killing legitimate long-running research
        # builds. Don't let anyone regress below the safe floor.
        for value in switch_to_builder_module.TASK_TYPE_TIMEOUTS.values():
            assert value > 120
        assert switch_to_builder_module.DEFAULT_TIMEOUT_SECONDS > 120


class TestSwitchToBuilderInputSchema:
    def test_retry_attempt_defaults_to_zero(self):
        payload = switch_to_builder_module.SwitchToBuilderInput(
            task="Draft a doc",
            task_type="document",
        )
        assert payload.retry_attempt == 0

    def test_retry_attempt_accepts_one(self):
        payload = switch_to_builder_module.SwitchToBuilderInput(
            task="Draft a doc",
            task_type="document",
            retry_attempt=1,
        )
        assert payload.retry_attempt == 1

    def test_retry_attempt_rejects_three(self):
        from pydantic import ValidationError
        try:
            switch_to_builder_module.SwitchToBuilderInput(
                task="Draft a doc",
                task_type="document",
                retry_attempt=3,
            )
        except ValidationError:
            return
        raise AssertionError("retry_attempt=3 should be rejected")

    def test_retry_attempt_rejects_negative(self):
        from pydantic import ValidationError
        try:
            switch_to_builder_module.SwitchToBuilderInput(
                task="Draft a doc",
                task_type="document",
                retry_attempt=-1,
            )
        except ValidationError:
            return
        raise AssertionError("retry_attempt=-1 should be rejected")


class TestBuildPartialBuilderUpdateStatusTaxonomy:
    def _make_timed_out_result(self):
        return SimpleNamespace(
            task_id="toolu_partial",
            final_state={
                "builder_result": {
                    "artifact_path": "outputs/draft.md",
                    "artifact_title": "draft.md",
                }
            },
            ai_messages=[],
            result="partial draft",
        )

    def test_partial_first_attempt_marks_failed_retryable(self, monkeypatch):
        monkeypatch.setattr(
            switch_to_builder_module,
            "build_builder_delivery_payload",
            lambda *, thread_id, builder_result: {
                "source": "builder_result",
                "attachments": [{"virtual_path": "/mnt/user-data/outputs/draft.md"}],
            },
        )

        command = switch_to_builder_module._build_partial_builder_update(
            result=self._make_timed_out_result(),
            task="Write a report",
            task_type="document",
            task_id="toolu_partial",
            status="timed_out",
            thread_id="thread-xyz",
            tool_call_id="toolu_partial",
            failure_reason="Timed out after 600s",
            retry_attempt=0,
        )

        assert command is not None
        builder_result = command.update["builder_result"]
        assert builder_result["status"] == switch_to_builder_module.BUILDER_STATUS_FAILED_RETRYABLE
        message = command.update["messages"][0]
        assert "try again" in message.content.lower()

    def test_partial_second_attempt_marks_failed_terminal(self, monkeypatch):
        monkeypatch.setattr(
            switch_to_builder_module,
            "build_builder_delivery_payload",
            lambda *, thread_id, builder_result: {
                "source": "builder_result",
                "attachments": [{"virtual_path": "/mnt/user-data/outputs/draft.md"}],
            },
        )

        command = switch_to_builder_module._build_partial_builder_update(
            result=self._make_timed_out_result(),
            task="Write a report",
            task_type="document",
            task_id="toolu_partial_2",
            status="failed",
            thread_id="thread-xyz",
            tool_call_id="toolu_partial_2",
            failure_reason="Second attempt also failed",
            retry_attempt=1,
        )

        assert command is not None
        builder_result = command.update["builder_result"]
        assert builder_result["status"] == switch_to_builder_module.BUILDER_STATUS_FAILED_TERMINAL
        message = command.update["messages"][0]
        assert "alternatives" in message.content.lower()

    def test_partial_without_recoverable_output_returns_none(self):
        empty_result = SimpleNamespace(
            task_id="toolu_empty",
            final_state={
                "builder_result": {
                    "artifact_path": None,
                    "supporting_files": None,
                }
            },
            ai_messages=[],
            result="nothing",
        )

        command = switch_to_builder_module._build_partial_builder_update(
            result=empty_result,
            task="Write a report",
            task_type="document",
            task_id="toolu_empty",
            status="timed_out",
            thread_id="thread-xyz",
            tool_call_id="toolu_empty",
            failure_reason="Timed out after 600s",
            retry_attempt=0,
        )

        assert command is None
