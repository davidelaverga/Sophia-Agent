from __future__ import annotations

import pytest

from voice.realtime.coreview import (
    COREVIEW_FEATURE_FLAG,
    COREVIEW_FIXTURE_ARTIFACT_ID,
    COREVIEW_FIXTURE_EXACT_TEXT,
    COREVIEW_STILL_FRAME_FEATURE_FLAG,
    GEMINI_COREVIEW_ACTION_TOOL_NAMES,
    GEMINI_COREVIEW_SET_VIEW_TOOL_NAME,
    GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME,
    build_gemini_coreview_prompt_overlay,
    coreview_tool_parity_status,
    detect_gemini_coreview_media_support,
    execute_read_artifact_text_feature_gated,
)
from voice.realtime.gemini_tool_loop import GeminiDogfoodToolExecutor, GeminiLiveFunctionCall
from voice.realtime.runtime_selection import VoiceRuntimeMode
from voice.realtime.sophia_backend_tools import gemini_sophia_function_declarations
from voice.realtime.sophia_prompt import build_gemini_live_realtime_setup_instructions


def test_read_artifact_text_remains_feature_flagged_by_default(monkeypatch) -> None:
    monkeypatch.delenv(COREVIEW_FEATURE_FLAG, raising=False)

    declarations = gemini_sophia_function_declarations()
    assert GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME not in [declaration["name"] for declaration in declarations]

    response = execute_read_artifact_text_feature_gated(
        {"artifact_id": "artifact-1", "query": "exact number"},
        session_id="session-1",
        user_id="user-1",
        provider="gemini",
    )
    assert response["ok"] is False
    assert response["status"] == "unavailable"
    assert "exact number" not in response.values()


def test_coreview_prompt_appears_only_when_enabled(monkeypatch) -> None:
    monkeypatch.delenv(COREVIEW_FEATURE_FLAG, raising=False)
    prompt = build_gemini_live_realtime_setup_instructions()
    assert "<gemini_coreview_artifact_policy>" not in prompt

    monkeypatch.setenv(COREVIEW_FEATURE_FLAG, "1")
    prompt = build_gemini_live_realtime_setup_instructions()
    assert "<gemini_coreview_artifact_policy>" in prompt
    assert "Exact words, numbers, table values" in prompt
    assert "call read_artifact_text for the current artifact before answering" in prompt
    assert "answer from a fresh frame directly or call coreview_get_current_view" in prompt
    assert "coreview_set_view" in prompt
    assert "Do not call emit_artifact, start_builder_task" in prompt
    assert "Still-frame co-review" in prompt


def test_normal_voice_tool_declarations_unchanged_when_flag_off(monkeypatch) -> None:
    monkeypatch.delenv(COREVIEW_FEATURE_FLAG, raising=False)

    declarations = gemini_sophia_function_declarations()

    assert [declaration["name"] for declaration in declarations] == [
        "emit_artifact",
        "start_builder_task",
        "check_async_task",
        "update_async_task",
        "cancel_async_task",
        "list_async_tasks",
        "retrieve_memories",
    ]


def test_coreview_tool_declaration_is_opt_in(monkeypatch) -> None:
    monkeypatch.setenv(COREVIEW_FEATURE_FLAG, "true")

    declarations = gemini_sophia_function_declarations()
    names = [declaration["name"] for declaration in declarations]

    assert GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME in names
    assert GEMINI_COREVIEW_ACTION_TOOL_NAMES.issubset(set(names))
    read_declaration = next(
        declaration for declaration in declarations if declaration["name"] == GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME
    )
    set_view_declaration = next(
        declaration for declaration in declarations if declaration["name"] == GEMINI_COREVIEW_SET_VIEW_TOOL_NAME
    )
    assert read_declaration["parameters"]["required"] == ["query"]
    assert "page_number" in set_view_declaration["parameters"]["properties"]


def test_read_artifact_text_returns_fixture_exact_text(monkeypatch) -> None:
    monkeypatch.setenv(COREVIEW_FEATURE_FLAG, "true")

    response = execute_read_artifact_text_feature_gated(
        {"artifact_id": COREVIEW_FIXTURE_ARTIFACT_ID, "query": "exact table value"},
        session_id="session-1",
        user_id="user-1",
        provider="gemini",
    )

    assert response == {
        "ok": True,
        "artifact_id": COREVIEW_FIXTURE_ARTIFACT_ID,
        "source": "fixture",
        "text": COREVIEW_FIXTURE_EXACT_TEXT,
        "truncated": False,
        "char_count": len(COREVIEW_FIXTURE_EXACT_TEXT),
    }


def test_read_artifact_text_returns_safe_unsupported_for_unknown_real_artifact(monkeypatch) -> None:
    monkeypatch.setenv(COREVIEW_FEATURE_FLAG, "true")

    response = execute_read_artifact_text_feature_gated(
        {"artifact_id": "coreview-real-artifact-report-md", "query": "read the body"},
        session_id="session-1",
        user_id="user-1",
        provider="gemini",
    )

    assert response["ok"] is False
    assert response["artifact_id"] == "coreview-real-artifact-report-md"
    assert response["status"] == "unsupported"
    assert "unsupported" in response["safe_reason"].lower()
    assert "read the body" not in response.values()


def test_read_artifact_text_returns_safe_not_found_for_unregistered_artifact(monkeypatch) -> None:
    monkeypatch.setenv(COREVIEW_FEATURE_FLAG, "true")

    response = execute_read_artifact_text_feature_gated(
        {"artifact_id": "artifact-from-another-session", "query": "heading"},
        session_id="session-1",
        user_id="user-1",
        provider="gemini",
    )

    assert response == {
        "ok": False,
        "artifact_id": "artifact-from-another-session",
        "status": "not_found",
        "safe_reason": "No trusted artifact text source is registered for that artifact_id.",
    }


def test_read_artifact_text_returns_no_selected_artifact_without_artifact_id(monkeypatch) -> None:
    monkeypatch.setenv(COREVIEW_FEATURE_FLAG, "true")

    response = execute_read_artifact_text_feature_gated(
        {"query": "heading"},
        session_id="session-1",
        user_id="user-1",
        provider="gemini",
    )

    assert response == {
        "ok": False,
        "artifact_id": None,
        "status": "no_selected_artifact",
        "safe_reason": "No artifact is selected for trusted text reading.",
    }


def test_media_transport_support_detection_reports_unsupported_safely(monkeypatch) -> None:
    monkeypatch.delenv(COREVIEW_FEATURE_FLAG, raising=False)
    monkeypatch.delenv(COREVIEW_STILL_FRAME_FEATURE_FLAG, raising=False)

    report = detect_gemini_coreview_media_support()

    assert report.transport_kind == "gemini_live_audio_websocket_current_path"
    assert report.still_frames_supported is False
    assert report.tools_supported_in_normal_voice is True
    assert report.tools_supported_in_coreview_media == "unknown"
    assert report.read_artifact_text_available is False
    assert any("not provider-ack verified" in blocker for blocker in report.blockers)


def test_still_frame_support_detection_is_separately_feature_flagged(monkeypatch) -> None:
    monkeypatch.setenv(COREVIEW_FEATURE_FLAG, "1")
    monkeypatch.delenv(COREVIEW_STILL_FRAME_FEATURE_FLAG, raising=False)
    assert detect_gemini_coreview_media_support().still_frames_supported is False

    monkeypatch.setenv(COREVIEW_STILL_FRAME_FEATURE_FLAG, "1")
    report = detect_gemini_coreview_media_support()

    assert report.still_frames_supported is True
    assert "coreviewEnabled" in report.safe_telemetry_fields
    assert "coreviewSessionActive" in report.safe_telemetry_fields
    assert "coreviewArtifactId" in report.safe_telemetry_fields
    assert "visualSourceKind" in report.safe_telemetry_fields
    assert "frameBytes" in report.safe_telemetry_fields
    assert "lastFrameBytes" in report.safe_telemetry_fields
    assert "lastFrameDimensions" in report.safe_telemetry_fields
    assert "visualFresh" in report.safe_telemetry_fields
    assert "visualFreshForTurn" in report.safe_telemetry_fields
    assert "exactTextAvailable" in report.safe_telemetry_fields
    assert "refreshFrameCount" in report.safe_telemetry_fields
    assert "providerUsageImageCount" in report.safe_telemetry_fields
    assert "exactTextCallCount" in report.safe_telemetry_fields
    assert "readArtifactTextCallCount" in report.safe_telemetry_fields
    assert "providerAcceptedFrame" in report.safe_telemetry_fields
    assert "rawFrameExcluded" in report.safe_telemetry_fields
    assert "rawProviderPayloadExcluded" in report.safe_telemetry_fields
    assert "rawArtifactTextExcluded" in report.safe_telemetry_fields


def test_tool_parity_status_is_reported(monkeypatch) -> None:
    monkeypatch.setenv(COREVIEW_FEATURE_FLAG, "1")

    status = coreview_tool_parity_status()

    assert status["normal_voice_tools_supported"] is True
    assert status["coreview_media_tools_supported"] == "unknown"
    assert status["read_artifact_text_available"] is True


@pytest.mark.anyio
async def test_read_artifact_text_tool_loop_returns_flagged_safe_status(monkeypatch) -> None:
    monkeypatch.delenv(COREVIEW_FEATURE_FLAG, raising=False)
    executor = GeminiDogfoodToolExecutor()

    execution = await executor.execute(
        GeminiLiveFunctionCall(
            call_id="call-1",
            name=GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME,
            args={"artifact_id": "artifact-1", "query": "tiny table value"},
        ),
        session_id="session-1",
        user_id="user-1",
        runtime_mode=VoiceRuntimeMode.GEMINI_LIVE,
        provider="gemini",
    )

    assert execution.success is False
    assert execution.response["status"] == "unavailable"
    assert "tiny table value" not in execution.response.values()


@pytest.mark.anyio
async def test_read_artifact_text_tool_loop_returns_fixture_without_raw_text_telemetry(monkeypatch) -> None:
    monkeypatch.setenv(COREVIEW_FEATURE_FLAG, "true")
    executor = GeminiDogfoodToolExecutor()

    execution = await executor.execute(
        GeminiLiveFunctionCall(
            call_id="call-1",
            name=GEMINI_READ_ARTIFACT_TEXT_TOOL_NAME,
            args={"artifact_id": COREVIEW_FIXTURE_ARTIFACT_ID, "query": "What exact number is in the table?"},
        ),
        session_id="session-1",
        user_id="user-1",
        runtime_mode=VoiceRuntimeMode.GEMINI_LIVE,
        provider="gemini",
    )

    diagnostic = execution.diagnostic()

    assert execution.success is True
    assert execution.response["text"] == COREVIEW_FIXTURE_EXACT_TEXT
    assert diagnostic["response"] == {
        "ok": True,
        "artifact_id": COREVIEW_FIXTURE_ARTIFACT_ID,
        "source": "fixture",
        "char_count": len(COREVIEW_FIXTURE_EXACT_TEXT),
        "truncated": False,
        "status": "success",
        "latency_ms": diagnostic["latency_ms"],
        "raw_artifact_text_excluded": True,
    }
    assert COREVIEW_FIXTURE_EXACT_TEXT not in str(diagnostic)


@pytest.mark.anyio
async def test_coreview_action_tool_loop_returns_browser_owned_fallback(monkeypatch) -> None:
    monkeypatch.setenv(COREVIEW_FEATURE_FLAG, "true")
    executor = GeminiDogfoodToolExecutor()

    execution = await executor.execute(
        GeminiLiveFunctionCall(
            call_id="call-coreview-set",
            name=GEMINI_COREVIEW_SET_VIEW_TOOL_NAME,
            args={"page_number": 2, "reason": "user asked for page two"},
        ),
        session_id="session-1",
        user_id="user-1",
        runtime_mode=VoiceRuntimeMode.GEMINI_LIVE,
        provider="gemini",
    )
    diagnostic = execution.diagnostic()

    assert execution.success is False
    assert execution.response["ok"] is False
    assert execution.response["blocked_reason"] == "browser_coreview_tool_bridge_unavailable"
    assert execution.response["raw_artifact_text_excluded"] is True
    assert execution.response["raw_frame_excluded"] is True
    assert diagnostic["response"]["raw_artifact_text_excluded"] is True
    assert diagnostic["response"]["raw_frame_excluded"] is True
    assert "user asked for page two" not in str(diagnostic)


def test_explicit_overlay_builder_is_empty_when_disabled() -> None:
    assert build_gemini_coreview_prompt_overlay(enabled=False) == ""
    assert "<gemini_coreview_artifact_policy>" in build_gemini_coreview_prompt_overlay(enabled=True)
