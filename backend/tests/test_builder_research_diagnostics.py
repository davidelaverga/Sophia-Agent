from __future__ import annotations

import logging
from types import SimpleNamespace

from langchain_core.messages import ToolMessage
from langgraph.types import Command

from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware


def test_research_diagnostics_counts_web_and_write_tools():
    state = {"builder_research_diagnostics": None}

    diagnostics = BuilderArtifactMiddleware._update_research_diagnostics(
        state,
        ["builder_web_search", "builder_web_fetch", "write_file"],
    )

    assert diagnostics["builder_web_search_count"] == 1
    assert diagnostics["builder_web_fetch_count"] == 1
    assert diagnostics["write_file_count"] == 1
    assert diagnostics["first_content_tool"] == "write_file"
    assert diagnostics["wrote_before_research"] is False


def test_research_diagnostics_warns_when_write_happens_before_research(caplog):
    diagnostics = BuilderArtifactMiddleware._update_research_diagnostics(
        {},
        ["write_file"],
    )

    with caplog.at_level(logging.WARNING, logger="deerflow.agents.sophia_agent.middlewares.builder_artifact"):
        BuilderArtifactMiddleware._log_research_diagnostics(
            phase="progress",
            diagnostics=diagnostics,
            allow_web_research=True,
        )

    assert diagnostics["wrote_before_research"] is True
    assert "reason=research_enabled_no_web_tools" in caplog.text


def test_research_diagnostics_logs_empty_sources_on_completion(caplog):
    diagnostics = {
        "builder_web_search_count": 1,
        "builder_web_fetch_count": 1,
        "write_file_count": 1,
        "first_content_tool": "write_file",
        "wrote_before_research": False,
    }

    with caplog.at_level(logging.WARNING, logger="deerflow.agents.sophia_agent.middlewares.builder_artifact"):
        BuilderArtifactMiddleware._log_research_diagnostics(
            phase="completion",
            diagnostics=diagnostics,
            allow_web_research=True,
            sources_used=[],
        )

    assert "reason=research_enabled_empty_sources_used" in caplog.text


def _tool_request(name: str, state: dict, args: dict | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        tool_call={"name": name, "args": args or {}, "id": f"tc-{name}"},
        state=state,
    )


def test_write_todos_first_is_allowed_before_research():
    mw = BuilderArtifactMiddleware()
    request = _tool_request("write_todos", {"allow_web_research": True})
    expected = object()

    result = mw.wrap_tool_call(request, lambda _request: expected)

    assert result is expected


def test_write_file_before_research_is_blocked():
    mw = BuilderArtifactMiddleware()
    request = _tool_request(
        "write_file",
        {"allow_web_research": True},
        {"path": "/mnt/user-data/outputs/report.md", "content": "# Report"},
    )

    result = mw.wrap_tool_call(request, lambda _request: object())

    assert isinstance(result, Command)
    tool_message = result.update["messages"][0]
    assert tool_message.status == "error"
    assert "research-before-write enforcement blocked" in tool_message.content


def test_artifact_emit_before_research_is_blocked():
    mw = BuilderArtifactMiddleware()
    request = _tool_request(
        "emit_builder_artifact",
        {"allow_web_research": True},
        {"artifact_path": "/mnt/user-data/outputs/report.md"},
    )

    result = mw.wrap_tool_call(request, lambda _request: object())

    assert isinstance(result, Command)
    assert result.goto == "model"


def test_safe_bash_before_research_is_allowed():
    mw = BuilderArtifactMiddleware()
    request = _tool_request(
        "bash",
        {"allow_web_research": True},
        {"command": "ls /mnt/user-data/outputs"},
    )
    expected = object()

    result = mw.wrap_tool_call(request, lambda _request: expected)

    assert result is expected


def test_artifact_generating_bash_before_research_is_blocked():
    mw = BuilderArtifactMiddleware()
    request = _tool_request(
        "bash",
        {"allow_web_research": True},
        {"command": "python /mnt/user-data/outputs/_generate_report.py"},
    )

    result = mw.wrap_tool_call(request, lambda _request: object())

    assert isinstance(result, Command)


def test_failed_research_attempt_unlocks_writing():
    mw = BuilderArtifactMiddleware()
    request = _tool_request(
        "write_file",
        {
            "allow_web_research": True,
            "builder_web_budget": {"search_calls": 1},
        },
        {"path": "/mnt/user-data/outputs/report.md", "content": "# Report"},
    )
    expected = object()

    result = mw.wrap_tool_call(request, lambda _request: expected)

    assert result is expected


def test_force_choice_searches_after_planning_before_writing():
    state = {
        "allow_web_research": True,
        "builder_tool_turn_summaries": [
            {"turn": 1, "tool_names": ["write_todos"], "has_emit_builder_artifact": False}
        ],
    }

    choice = BuilderArtifactMiddleware()._force_choice_for_state(state)

    assert choice == {"type": "tool", "name": "builder_web_search"}


def test_force_choice_fetches_explicit_url_after_planning():
    state = {
        "allow_web_research": True,
        "explicit_user_urls": ["https://example.com/source"],
        "builder_tool_turn_summaries": [
            {"turn": 1, "tool_names": ["write_todos"], "has_emit_builder_artifact": False}
        ],
    }

    choice = BuilderArtifactMiddleware()._force_choice_for_state(state)

    assert choice == {"type": "tool", "name": "builder_web_fetch"}


def test_write_result_command_records_safe_success_metadata():
    mw = BuilderArtifactMiddleware()
    request = _tool_request(
        "write_file",
        {"allow_web_research": True, "builder_web_budget": {"search_calls": 1}},
        {"path": "report.html", "content": "<html />"},
    )
    result = mw._write_result_command(
        request,
        ToolMessage(content="OK", tool_call_id="tc-write_file", name="write_file"),
    )

    assert isinstance(result, Command)
    diagnostics = result.update["builder_write_diagnostics"]
    assert diagnostics["success_count"] == 1
    assert diagnostics["error_count"] == 0
    assert diagnostics["last_ext"] == "html"
    assert diagnostics["last_under_outputs"] is True
    assert diagnostics["last_content_shape"] == "text"
    assert diagnostics["successful_output_paths"] == ["/mnt/user-data/outputs/report.html"]
    assert diagnostics["successful_deliverable_output_paths"] == ["/mnt/user-data/outputs/report.html"]


def test_write_result_command_records_safe_error_class():
    mw = BuilderArtifactMiddleware()
    request = _tool_request(
        "write_file",
        {"allow_web_research": True, "builder_web_budget": {"search_calls": 1}},
        {"path": "/mnt/user-data/outputs/report.md", "content": "# Report"},
    )
    result = mw._write_result_command(
        request,
        ToolMessage(
            content="Error: Thread ID not available in runtime context",
            tool_call_id="tc-write_file",
            name="write_file",
        ),
    )

    assert isinstance(result, Command)
    diagnostics = result.update["builder_write_diagnostics"]
    assert diagnostics["success_count"] == 0
    assert diagnostics["error_count"] == 1
    assert diagnostics["last_error_class"] == "missing_thread_id"
    assert diagnostics["last_content_shape"] == "text"


def test_recover_emit_args_uses_single_successful_deliverable(tmp_path):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "report.html").write_text("<html />")
    state = {
        "thread_data": {"outputs_path": str(outputs)},
        "builder_write_diagnostics": {
            "successful_output_paths": ["/mnt/user-data/outputs/report.html"],
        },
    }
    runtime = SimpleNamespace(context={"thread_id": "thread-1"})
    recovered = BuilderArtifactMiddleware._recover_emit_args_from_last_write(
        {"artifact_path": "/mnt/user-data/outputs/build.html"},
        state,
        runtime,
    )

    assert recovered is not None
    assert recovered["artifact_path"] == "/mnt/user-data/outputs/report.html"


def test_recover_emit_args_ignores_internal_helper_script(tmp_path):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "_gen_report.py").write_text("print('helper')")
    (outputs / "report.html").write_text("<html />")
    state = {
        "thread_data": {"outputs_path": str(outputs)},
        "builder_write_diagnostics": {
            "successful_output_paths": [
                "/mnt/user-data/outputs/_gen_report.py",
                "/mnt/user-data/outputs/report.html",
            ],
            "last_successful_output_path": "/mnt/user-data/outputs/report.html",
        },
    }
    runtime = SimpleNamespace(context={"thread_id": "thread-1"})

    recovered = BuilderArtifactMiddleware._recover_emit_args_from_last_write(
        {"artifact_path": "/mnt/user-data/outputs/build.html"},
        state,
        runtime,
    )

    assert recovered is not None
    assert recovered["artifact_path"] == "/mnt/user-data/outputs/report.html"


def test_recovered_deliverable_promotes_successful_write_after_errors(tmp_path, monkeypatch):
    from deerflow.agents.sophia_agent.middlewares import builder_artifact as mod

    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "report.html").write_text("<html />")
    captured: dict = {}
    monkeypatch.setattr(mod, "_upload_builder_outputs_to_supabase", lambda **_kwargs: None)
    monkeypatch.setattr(
        mod,
        "fire_completion_webhook_from_artifact",
        lambda **kwargs: captured.update(kwargs),
    )

    state = {
        "thread_data": {"outputs_path": str(outputs)},
        "delegation_context": {"parent_thread_id": "parent-1"},
        "builder_write_diagnostics": {
            "success_count": 1,
            "error_count": 3,
            "last_status": "success",
            "successful_output_paths": [
                "/mnt/user-data/outputs/_gen_report.py",
                "/mnt/user-data/outputs/report.html",
            ],
            "last_successful_output_path": "/mnt/user-data/outputs/report.html",
        },
    }
    runtime = SimpleNamespace(context={"thread_id": "builder-1"})

    result = BuilderArtifactMiddleware().before_model(state, runtime)

    assert result is not None
    assert result["jump_to"] == "end"
    assert result["builder_result"]["artifact_path"] == "/mnt/user-data/outputs/report.html"
    assert captured["status"] == "completed"
