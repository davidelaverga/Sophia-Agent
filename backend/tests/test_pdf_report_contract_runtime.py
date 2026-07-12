from __future__ import annotations

import json
from types import SimpleNamespace

from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.types import Command

from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    BuilderArtifactMiddleware,
    _apply_artifact_request_metadata,
)


def _request(payload: dict, *, state: dict | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        tool_call={"id": "render-1", "name": "render_html_to_pdf", "args": {}},
        state={
            "builder_artifact_target_path": "/mnt/user-data/outputs/report.pdf",
            "delegation_context": {"task_type": "visual_report"},
            **(state or {}),
        },
        runtime=SimpleNamespace(context={}, config={}, state={}),
        payload=payload,
    )


def _result(payload: dict) -> ToolMessage:
    return ToolMessage(
        content=json.dumps(payload),
        tool_call_id="render-1",
        name="render_html_to_pdf",
    )


def test_first_report_contract_failure_requests_one_real_source_repair() -> None:
    payload = {
        "success": False,
        "retryable": True,
        "error_type": "report_contract_failed",
        "report_contract_status": "rejected",
        "report_contract_problems": [
            "report_manifest.sections[2].id:architecture",
            "report_manifest.visuals[0].id:memory-pipeline",
        ],
    }
    command = BuilderArtifactMiddleware()._pdf_result_command(_request(payload), _result(payload))

    assert isinstance(command, Command)
    assert command.goto == "model"
    assert command.update["builder_pdf_contract_repair_attempts"] == 1
    assert command.update["builder_pdf_contract_repair_pending"] is True
    assert command.update["builder_pdf_phase"] == "repair_pending"
    messages = command.update["messages"]
    assert isinstance(messages[0], ToolMessage)
    assert isinstance(messages[1], HumanMessage)
    assert "architecture" in str(messages[1].content)


def test_second_report_contract_failure_is_terminal_and_has_no_primary_artifact(monkeypatch) -> None:
    payload = {
        "success": False,
        "retryable": True,
        "error_type": "report_contract_failed",
        "report_contract_status": "rejected",
        "report_contract_version": "report_manifest_v1",
        "report_contract_problems": ["report_manifest.sections:body_section_count"],
        "expected_section_count": 8,
        "found_section_count": 3,
    }
    middleware = BuilderArtifactMiddleware()
    monkeypatch.setattr(middleware, "_upload_fallback_and_fire", lambda **_kwargs: None)
    command = middleware._pdf_result_command(
        _request(payload, state={"builder_pdf_contract_repair_attempts": 1}),
        _result(payload),
    )

    assert isinstance(command, Command)
    assert command.goto == "end"
    artifact = command.update["builder_result"]
    assert artifact["artifact_path"] is None
    assert artifact["terminal_status"] == "failed"
    assert artifact["terminal_reason"] == "pdf_report_contract_failed"
    assert artifact["expected_section_count"] == 8
    assert artifact["found_section_count"] == 3


def test_pdf_source_is_not_forced_to_render_before_completion_window(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "report.html").write_text("<html><body><section>Draft</section></body></html>")
    state = {
        "thread_data": {"outputs_path": str(outputs)},
        "builder_artifact_target_path": "/mnt/user-data/outputs/report.pdf",
        "delegation_context": {"task_type": "visual_report"},
        "builder_non_artifact_turns": 7,
    }

    assert BuilderArtifactMiddleware()._pdf_render_source_tool_choice_for_state(state) is None


def test_completed_artifact_with_failure_reason_is_normalized_to_failed() -> None:
    artifact = _apply_artifact_request_metadata(
        {
            "artifact_path": "/mnt/user-data/outputs/report.pdf",
            "status": "completed",
            "terminal_reason": "pdf_generation_failed",
        },
        {"builder_artifact_target_path": "/mnt/user-data/outputs/report.pdf"},
    )

    assert artifact["status"] == "failed"
    assert artifact["terminal_status"] == "failed"
    assert artifact["terminal_reason"] == "pdf_generation_failed"


def test_successful_canonical_pdf_uses_success_terminal_reason() -> None:
    artifact = _apply_artifact_request_metadata(
        {
            "artifact_path": "/mnt/user-data/outputs/report.pdf",
            "status": "completed",
        },
        {
            "builder_artifact_target_path": "/mnt/user-data/outputs/report.pdf",
            "builder_pdf_render_result": {
                "success": True,
                "report_contract_status": "accepted",
                "report_contract_version": "report_manifest_v1",
            },
        },
    )

    assert artifact["terminal_status"] == "completed"
    assert artifact["terminal_reason"] == "artifact_emitted"
    assert artifact["report_contract_status"] == "accepted"


def test_off_target_pdf_after_layout_repair_budget_terminates_without_artifact(monkeypatch) -> None:
    payload = {
        "success": True,
        "pdf_path": "/mnt/user-data/outputs/report.pdf",
        "requested_page_count": 12,
        "requested_page_count_max": 16,
        "page_count": 5,
        "layout_quality": "warning",
        "layout_warning": "page_count_off_target",
        "report_contract_status": "accepted",
        "report_contract_version": "report_manifest_v1",
    }
    middleware = BuilderArtifactMiddleware()
    monkeypatch.setattr(middleware, "_upload_fallback_and_fire", lambda **_kwargs: None)
    command = middleware._pdf_result_command(
        _request(
            payload,
            state={
                "builder_pdf_layout_repair_attempts": 2,
                "builder_requested_page_count": 12,
                "builder_requested_page_count_max": 16,
            },
        ),
        _result(payload),
    )

    assert isinstance(command, Command)
    assert command.goto == "end"
    artifact = command.update["builder_result"]
    assert artifact["artifact_path"] is None
    assert artifact["terminal_status"] == "failed"
    assert artifact["terminal_reason"] == "pdf_page_count_off_target"
    assert artifact["requested_pages"] == 12
    assert artifact["actual_pages"] == 5
